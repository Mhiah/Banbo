//! Banbo factory: creates a vault in one transaction.
//!
//! The factory keeps one copy of the Banbo contract (set by its owner with
//! `set_vault_code`). `create_vault("acme", ...)` makes `acme.<factory>` and,
//! atomically in one receipt, funds it, deploys that exact code and
//! initializes it with the caller as its owner. A vault has no access key, so
//! nobody, including the factory's owner, can change its code afterwards; anyone
//! can check it against the published source by its code hash
//! (`scripts/reproducible-build.sh --account <vault>`). If any step fails the
//! account isn't created and the deposit goes back to the caller.
//!
//! The vault pays for its own copy of the code from the creation deposit
//! (NEAR storage staking: about 7.7 NEAR for banbo.wasm), so the deposit must
//! cover that plus a working balance.
use near_sdk::json_types::{Base58CryptoHash, U128};
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError};

/// What a new vault needs on top of its code's storage: its own state and
/// records, plus the 0.5 NEAR the vault always keeps back for gas.
pub const MIN_WORKING_DEPOSIT: NearToken = NearToken::from_near(1);
const INIT_GAS: Gas = Gas::from_tgas(30);
const CALLBACK_GAS: Gas = Gas::from_tgas(10);
const CODE_KEY: &[u8] = b"vault_code";
/// Display names live under their own keys, so adding them didn't change the
/// factory's state layout.
const NAME_PREFIX: &[u8] = b"name:";
/// The vaults each owner created here, also under their own keys, so a wallet
/// can find its vault from any device.
const VAULTS_PREFIX: &[u8] = b"vaults:";
pub const MAX_NAME_LEN: usize = 32;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Factory {
    /// Can set the code *future* vaults get. Existing vaults keep the code
    /// they were created with.
    owner: AccountId,
    /// sha256 of the stored vault code, as NEAR shows code hashes.
    vault_code_hash: Option<Base58CryptoHash>,
    vault_code_len: u64,
    created: u64,
}

#[near(serializers = [json])]
pub struct FactoryInfo {
    pub owner: AccountId,
    /// The code hash every new vault will have (None until the code is set).
    pub vault_code_hash: Option<Base58CryptoHash>,
    pub vaults_created: u64,
    /// Smallest deposit `create_vault` accepts: the code's storage plus a
    /// working balance.
    pub min_deposit: U128,
}

/// A vault name: the part before `.<factory>`. 2–32 lowercase letters,
/// digits, `-` or `_`, starting and ending with a letter or digit.
pub fn valid_name(name: &str) -> bool {
    let b = name.as_bytes();
    (2..=32).contains(&b.len())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-' || *c == b'_')
        && b[0].is_ascii_alphanumeric()
        && b[b.len() - 1].is_ascii_alphanumeric()
        && !name.contains("--")
        && !name.contains("__")
}

#[near]
impl Factory {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self { owner, vault_code_hash: None, vault_code_len: 0, created: 0 }
    }

    /// Create `name.<factory>`, owned by the caller. The whole attached deposit
    /// goes to the vault; part of it stays locked as the storage for the
    /// vault's code. `period_ms` is the budget period (e.g. 86400000 for a
    /// day) and `shared_cap` the most all agents together may spend in one.
    #[payable]
    pub fn create_vault(&mut self, name: String, period_ms: u64, shared_cap: U128) -> Promise {
        require!(valid_name(&name), "vault name: 2-32 lowercase letters, digits, - or _");
        require!(self.vault_code_hash.is_some(), "the factory has no vault code yet");
        let deposit = env::attached_deposit();
        let min = self.min_deposit();
        require!(deposit >= min, format!("attach at least {min} for the vault's code storage and working balance"));
        require!(period_ms > 0, "period_ms must be > 0");
        let code = env::storage_read(CODE_KEY).unwrap_or_else(|| env::panic_str("vault code missing"));
        let owner = env::predecessor_account_id();
        let vault: AccountId = format!("{name}.{}", env::current_account_id()).parse().unwrap();
        let args = json!({ "owner": owner, "period_ms": period_ms, "shared_cap": shared_cap }).to_string().into_bytes();
        Promise::new(vault.clone())
            .create_account()
            .transfer(deposit)
            .deploy_contract(code)
            .function_call("new", args, NearToken::from_yoctonear(0), INIT_GAS)
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_created(vault, owner, U128(deposit.as_yoctonear())))
    }

    /// Returns the new vault's account id, or refunds the deposit if creation
    /// failed (the name was taken, or deploying or initializing failed).
    #[private]
    pub fn on_created(&mut self, vault: AccountId, owner: AccountId, deposit: U128, #[callback_result] r: Result<(), PromiseError>) -> Option<AccountId> {
        if r.is_ok() {
            self.created += 1;
            self.remember_vault(&owner, &vault);
            env::log_str(&format!("banbo vault created: {vault} owned by {owner}"));
            Some(vault)
        } else {
            env::log_str(&format!("banbo vault {vault} not created; refunding {} yoctoNEAR to {owner}", deposit.0));
            Promise::new(owner).transfer(NearToken::from_yoctonear(deposit.0)).detach();
            None
        }
    }

    /// Store the Banbo wasm (the raw call input) that future vaults get, and
    /// return its code hash. The factory's balance pays for storing it. Owner
    /// only; vaults already created keep their code.
    pub fn set_vault_code(&mut self) -> Base58CryptoHash {
        require!(env::predecessor_account_id() == self.owner, "only the factory owner");
        let code = env::input().unwrap_or_default();
        require!(code.starts_with(b"\0asm"), "the input must be a wasm file");
        let hash = Base58CryptoHash::from(env::sha256_array(&code));
        env::storage_write(CODE_KEY, &code);
        self.vault_code_hash = Some(hash);
        self.vault_code_len = code.len() as u64;
        env::log_str(&format!("banbo vault code set: {} ({} bytes)", String::from(&hash), code.len()));
        hash
    }

    /// Set the caller's display name (what the dashboard shows instead of the
    /// account id), or clear it with an empty string. Attach enough NEAR for
    /// the storage (0.01 NEAR is plenty); the rest is refunded, and clearing
    /// refunds the storage it frees.
    #[payable]
    pub fn set_display_name(&mut self, name: String) {
        let name = name.trim().to_string();
        require!(name.chars().count() <= MAX_NAME_LEN, "display name: at most 32 characters");
        require!(!name.chars().any(|c| c.is_control()), "display name: no control characters");
        let who = env::predecessor_account_id();
        let key = [NAME_PREFIX, who.as_bytes()].concat();
        let before = env::storage_usage();
        if name.is_empty() { env::storage_remove(&key); } else { env::storage_write(&key, name.as_bytes()); }
        let after = env::storage_usage();
        let byte = env::storage_byte_cost().as_yoctonear();
        let deposit = env::attached_deposit().as_yoctonear();
        let refund = if after > before {
            let cost = byte * (after - before) as u128;
            require!(deposit >= cost, format!("attach at least {} yoctoNEAR for storage", cost));
            deposit - cost
        } else {
            deposit + byte * (before - after) as u128
        };
        if refund > 0 { Promise::new(who).transfer(NearToken::from_yoctonear(refund)).detach(); }
    }

    /// The vaults `owner` created through this factory, oldest first. A vault's
    /// owner can change later, so callers should check `get_config().owner`.
    pub fn get_vaults(&self, owner: AccountId) -> Vec<AccountId> {
        self.vaults_of(&owner)
    }

    /// Add a vault this factory created before it kept the list above. Factory
    /// owner only; it must be `<name>.<factory>`. The factory pays the storage.
    pub fn record_vault(&mut self, vault: AccountId, owner: AccountId) {
        require!(env::predecessor_account_id() == self.owner, "only the factory owner");
        let suffix = format!(".{}", env::current_account_id());
        require!(vault.as_str().ends_with(&suffix), "not a vault of this factory");
        self.remember_vault(&owner, &vault);
    }

    pub fn get_display_name(&self, account_id: AccountId) -> Option<String> {
        env::storage_read(&[NAME_PREFIX, account_id.as_bytes()].concat()).and_then(|v| String::from_utf8(v).ok())
    }

    pub fn get_info(&self) -> FactoryInfo {
        FactoryInfo {
            owner: self.owner.clone(),
            vault_code_hash: self.vault_code_hash,
            vaults_created: self.created,
            min_deposit: U128(self.min_deposit().as_yoctonear()),
        }
    }
}

impl Factory {
    fn vaults_key(owner: &AccountId) -> Vec<u8> {
        [VAULTS_PREFIX, owner.as_bytes()].concat()
    }
    fn vaults_of(&self, owner: &AccountId) -> Vec<AccountId> {
        env::storage_read(&Self::vaults_key(owner))
            .map(|v| String::from_utf8(v).unwrap_or_default())
            .unwrap_or_default()
            .split('\n')
            .filter(|s| !s.is_empty())
            .filter_map(|s| s.parse().ok())
            .collect()
    }
    /// Append `vault` to `owner`'s list (no duplicates). About 50 bytes of
    /// storage, paid from the factory's balance.
    fn remember_vault(&mut self, owner: &AccountId, vault: &AccountId) {
        let mut list = self.vaults_of(owner);
        if list.contains(vault) { return; }
        list.push(vault.clone());
        let joined = list.iter().map(|a| a.as_str()).collect::<Vec<_>>().join("\n");
        env::storage_write(&Self::vaults_key(owner), joined.as_bytes());
    }
    fn min_deposit(&self) -> NearToken {
        env::storage_byte_cost().saturating_mul(self.vault_code_len as u128).saturating_add(MIN_WORKING_DEPOSIT)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const CODE: &[u8] = b"\0asm\x01\0\0\0 a tiny stand-in for banbo.wasm";

    fn ctx_with(caller: &str, deposit: NearToken, input: Vec<u8>) {
        let mut c = VMContextBuilder::new()
            .current_account_id("banbo-factory.testnet".parse().unwrap())
            .predecessor_account_id(caller.parse().unwrap())
            .attached_deposit(deposit)
            .account_balance(NearToken::from_near(100))
            .build();
        c.input = input.into();
        testing_env!(c);
    }
    fn ctx(caller: &str, deposit: NearToken) {
        ctx_with(caller, deposit, vec![]);
    }
    fn factory() -> Factory {
        ctx("mia.testnet", NearToken::from_yoctonear(0));
        Factory::new("mia.testnet".parse().unwrap())
    }
    fn factory_with_code() -> Factory {
        let mut f = factory();
        ctx_with("mia.testnet", NearToken::from_yoctonear(0), CODE.to_vec());
        f.set_vault_code();
        f
    }
    fn panics(f: impl FnOnce() + std::panic::UnwindSafe) -> bool {
        std::panic::catch_unwind(f).is_err()
    }

    #[test]
    fn names() {
        for ok in ["acme", "ab", "acme-treasury", "acme_2", "a1"] { assert!(valid_name(ok), "{ok}"); }
        for bad in ["a", "", "Acme", "acme.near", "-acme", "acme-", "a--b", "a b", &"x".repeat(33)] {
            assert!(!valid_name(bad), "{bad}");
        }
    }

    #[test]
    fn no_vaults_before_the_code_is_set() {
        let mut f = factory();
        assert_eq!(f.get_info().vault_code_hash, None);
        ctx("alice.testnet", NearToken::from_near(20));
        assert!(panics(move || { f.create_vault("acme".into(), 86_400_000, U128(1)); }));
    }

    #[test]
    fn set_vault_code_records_its_hash_and_raises_the_minimum_deposit() {
        let f = factory_with_code();
        let info = f.get_info();
        assert_eq!(info.vault_code_hash, Some(Base58CryptoHash::from(env::sha256_array(CODE))));
        let code_storage = env::storage_byte_cost().as_yoctonear() * CODE.len() as u128;
        assert_eq!(info.min_deposit.0, code_storage + MIN_WORKING_DEPOSIT.as_yoctonear());
        assert_eq!(env::storage_read(CODE_KEY).unwrap(), CODE);
    }

    #[test]
    fn only_wasm_from_the_owner_becomes_vault_code() {
        let mut f = factory();
        ctx_with("attacker.testnet", NearToken::from_yoctonear(0), CODE.to_vec());
        assert!(panics(std::panic::AssertUnwindSafe(|| { f.set_vault_code(); })));
        ctx_with("mia.testnet", NearToken::from_yoctonear(0), b"not wasm".to_vec());
        assert!(panics(std::panic::AssertUnwindSafe(|| { f.set_vault_code(); })));
        assert_eq!(f.get_info().vault_code_hash, None);
    }

    #[test]
    fn display_names_are_per_account_and_paid_for() {
        let mut f = factory();
        ctx("alice.testnet", NearToken::from_yoctonear(0));
        assert!(panics(std::panic::AssertUnwindSafe(|| f.set_display_name("Mia".into()))));
        ctx("alice.testnet", NearToken::from_millinear(10));
        f.set_display_name("  Mia  ".into());
        assert_eq!(f.get_display_name("alice.testnet".parse().unwrap()), Some("Mia".into()));
        assert_eq!(f.get_display_name("bob.testnet".parse().unwrap()), None);
        assert!(panics(std::panic::AssertUnwindSafe(|| f.set_display_name("x".repeat(33)))));
        assert!(panics(std::panic::AssertUnwindSafe(|| f.set_display_name("a\nb".into()))));
        f.set_display_name("".into());
        assert_eq!(f.get_display_name("alice.testnet".parse().unwrap()), None);
    }

    #[test]
    fn vaults_are_listed_per_owner_and_only_the_owner_backfills() {
        let mut f = factory();
        let alice: AccountId = "alice.testnet".parse().unwrap();
        let v: AccountId = "acme.banbo-factory.testnet".parse().unwrap();
        assert!(f.get_vaults(alice.clone()).is_empty());
        ctx("mallory.testnet", NearToken::from_yoctonear(0));
        assert!(panics(std::panic::AssertUnwindSafe(|| f.record_vault(v.clone(), alice.clone()))));
        ctx("mia.testnet", NearToken::from_yoctonear(0));
        assert!(panics(std::panic::AssertUnwindSafe(|| f.record_vault("acme.other.testnet".parse().unwrap(), alice.clone()))));
        f.record_vault(v.clone(), alice.clone());
        f.record_vault(v.clone(), alice.clone());
        let w: AccountId = "shop.banbo-factory.testnet".parse().unwrap();
        f.record_vault(w.clone(), alice.clone());
        assert_eq!(f.get_vaults(alice), vec![v, w]);
        assert!(f.get_vaults("bob.testnet".parse().unwrap()).is_empty());
    }

    #[test]
    fn create_needs_a_valid_name_and_enough_deposit() {
        let mut f = factory_with_code();
        let min = f.get_info().min_deposit.0;
        ctx("alice.testnet", NearToken::from_yoctonear(min - 1));
        assert!(panics(std::panic::AssertUnwindSafe(|| { f.create_vault("acme".into(), 86_400_000, U128(1)); })));
        ctx("alice.testnet", NearToken::from_yoctonear(min));
        assert!(panics(std::panic::AssertUnwindSafe(|| { f.create_vault("Acme".into(), 86_400_000, U128(1)); })));
        assert!(panics(std::panic::AssertUnwindSafe(|| { f.create_vault("acme".into(), 0, U128(1)); })));
        let _ = f.create_vault("acme".into(), 86_400_000, U128(1));
    }
}

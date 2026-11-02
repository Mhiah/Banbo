//! Banbo factory: creates a vault in one transaction.
//!
//! `create_vault("acme", ...)` makes `acme.<factory>` and, atomically in one
//! receipt, funds it, points it at the Banbo contract by **code hash** (a NEAR
//! global contract, so every vault runs exactly the same published code and
//! nobody, including the factory's owner, can change a vault's code later),
//! and initializes it with the caller as its owner. If any step fails the
//! account isn't created and the deposit goes back to the caller.
use near_sdk::json_types::{Base58CryptoHash, U128};
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError};

/// Smallest deposit a new vault can start with: its own storage plus room to
/// pay. The vault keeps 0.5 NEAR back for storage and gas.
pub const MIN_DEPOSIT: NearToken = NearToken::from_millinear(1_500);
const INIT_GAS: Gas = Gas::from_tgas(30);
const CALLBACK_GAS: Gas = Gas::from_tgas(10);

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Factory {
    /// Can point *future* vaults at a newer published version. Existing
    /// vaults keep the code they were created with.
    owner: AccountId,
    vault_code_hash: Base58CryptoHash,
    created: u64,
}

#[near(serializers = [json])]
pub struct FactoryInfo {
    pub owner: AccountId,
    pub vault_code_hash: Base58CryptoHash,
    pub vaults_created: u64,
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
    pub fn new(owner: AccountId, vault_code_hash: Base58CryptoHash) -> Self {
        Self { owner, vault_code_hash, created: 0 }
    }

    /// Create `name.<factory>`, owned by the caller. The whole attached deposit
    /// goes to the vault. `period_ms` is the budget period (e.g. 86400000 for a
    /// day) and `shared_cap` the most all agents together may spend in one.
    #[payable]
    pub fn create_vault(&mut self, name: String, period_ms: u64, shared_cap: U128) -> Promise {
        require!(valid_name(&name), "vault name: 2-32 lowercase letters, digits, - or _");
        let deposit = env::attached_deposit();
        require!(deposit >= MIN_DEPOSIT, format!("attach at least {MIN_DEPOSIT} for the vault's storage"));
        require!(period_ms > 0, "period_ms must be > 0");
        let owner = env::predecessor_account_id();
        let vault: AccountId = format!("{name}.{}", env::current_account_id()).parse().unwrap();
        let args = json!({ "owner": owner, "period_ms": period_ms, "shared_cap": shared_cap }).to_string().into_bytes();
        Promise::new(vault.clone())
            .create_account()
            .transfer(deposit)
            .use_global_contract(self.vault_code_hash)
            .function_call("new", args, NearToken::from_yoctonear(0), INIT_GAS)
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_created(vault, owner, U128(deposit.as_yoctonear())))
    }

    /// Returns the new vault's account id, or refunds the deposit if creation
    /// failed (the name was taken, or initialization failed).
    #[private]
    pub fn on_created(&mut self, vault: AccountId, owner: AccountId, deposit: U128, #[callback_result] r: Result<(), PromiseError>) -> Option<AccountId> {
        if r.is_ok() {
            self.created += 1;
            env::log_str(&format!("banbo vault created: {vault} owned by {owner}"));
            Some(vault)
        } else {
            env::log_str(&format!("banbo vault {vault} not created; refunding {} yoctoNEAR to {owner}", deposit.0));
            Promise::new(owner).transfer(NearToken::from_yoctonear(deposit.0)).detach();
            None
        }
    }

    /// Point future vaults at another published version of the Banbo contract.
    pub fn set_vault_code_hash(&mut self, vault_code_hash: Base58CryptoHash) {
        require!(env::predecessor_account_id() == self.owner, "only the factory owner");
        self.vault_code_hash = vault_code_hash;
    }

    /// Publish a Banbo wasm (the raw call input) as a global contract by its
    /// hash, paid from the factory's balance (NEAR burns 10x the normal
    /// storage cost for global code), and point future vaults at it once it's
    /// published. Owner only.
    pub fn publish_vault_code(&mut self) -> Promise {
        require!(env::predecessor_account_id() == self.owner, "only the factory owner");
        let code = env::input().unwrap_or_default();
        require!(code.starts_with(b"\0asm"), "the input must be a wasm file");
        let hash: [u8; 32] = env::sha256_array(&code);
        Promise::new(env::current_account_id())
            .deploy_global_contract(code)
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_published(Base58CryptoHash::from(hash)))
    }

    #[private]
    pub fn on_published(&mut self, hash: Base58CryptoHash, #[callback_result] r: Result<(), PromiseError>) -> Base58CryptoHash {
        require!(r.is_ok(), "publishing the vault code failed");
        self.vault_code_hash = hash;
        env::log_str(&format!("banbo vault code published: {}", String::from(&hash)));
        hash
    }

    pub fn get_info(&self) -> FactoryInfo {
        FactoryInfo {
            owner: self.owner.clone(),
            vault_code_hash: self.vault_code_hash,
            vaults_created: self.created,
            min_deposit: U128(MIN_DEPOSIT.as_yoctonear()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn ctx(caller: &str, deposit: NearToken) {
        testing_env!(VMContextBuilder::new()
            .current_account_id("banbo-factory.testnet".parse().unwrap())
            .predecessor_account_id(caller.parse().unwrap())
            .attached_deposit(deposit)
            .build());
    }
    fn factory() -> Factory {
        ctx("mia.testnet", NearToken::from_yoctonear(0));
        Factory::new("mia.testnet".parse().unwrap(), [7u8; 32].into())
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
    fn create_needs_a_valid_name_and_enough_deposit() {
        let mut f = factory();
        ctx("alice.testnet", NearToken::from_near(1));
        assert!(panics(move || { f.create_vault("acme".into(), 86_400_000, U128(1)); }));
        let mut f = factory();
        ctx("alice.testnet", NearToken::from_near(2));
        assert!(panics(move || { f.create_vault("Acme".into(), 86_400_000, U128(1)); }));
        let mut f = factory();
        ctx("alice.testnet", NearToken::from_near(2));
        let _ = f.create_vault("acme".into(), 86_400_000, U128(1));
    }

    #[test]
    fn only_the_owner_changes_the_code_hash_for_future_vaults() {
        let mut f = factory();
        ctx("attacker.testnet", NearToken::from_yoctonear(0));
        assert!(panics(std::panic::AssertUnwindSafe(|| f.set_vault_code_hash([9u8; 32].into()))));
        ctx("mia.testnet", NearToken::from_yoctonear(0));
        f.set_vault_code_hash([9u8; 32].into());
        assert_eq!(f.get_info().vault_code_hash, Base58CryptoHash::from([9u8; 32]));
    }
}

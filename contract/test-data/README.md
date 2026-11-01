# Test data

`tdx_quote.bin` and `tdx_quote_collateral.json` are a genuine Intel TDX quote
and its Intel collateral, from the samples of the
[dcap-qvl](https://github.com/Phala-Network/dcap-qvl) crate (MIT). The
collateral was valid from 2025-06-19 to 2025-07-19, so tests verify the quote
at a time inside that window. They prove that the contract runs real Intel
DCAP verification; the quote belongs to someone else's VM, so the later checks
(report data, measurements) must still reject it.

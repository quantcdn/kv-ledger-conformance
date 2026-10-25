# Test timestamp authority keys

The certificates and private keys in this folder are test-only. They were generated for the verifier tests (a test
root, intermediates and timestamp signers with different extended key usage settings). They sign only the test
timestamp tokens that the tests make. They are never used outside these tests, and no real timestamp authority
trusts them. Do not use them for anything else.

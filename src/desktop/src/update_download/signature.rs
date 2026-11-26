//! Minisign verification of a downloaded installer, with the same acceptance rules as the
//! updater plugin applies to its own downloads: the configured public key and the announced
//! signature are base64-wrapped minisign text, and a version recorded in the signed trusted
//! comment must match the announced version.

use base64::Engine;
use minisign_verify::{PublicKey, Signature};

/// Verifies `data` against the announced signature. `require_signed_version` rejects
/// signatures whose trusted comment records no version.
pub fn verify(
    data: &[u8],
    signature_b64: &str,
    public_key_b64: &str,
    announced_version: &str,
    require_signed_version: bool,
) -> Result<(), String> {
    let public_key = PublicKey::decode(&decode_text(public_key_b64, "public key")?)
        .map_err(|error| format!("invalid public key: {error}"))?;
    let signature = Signature::decode(&decode_text(signature_b64, "signature")?)
        .map_err(|error| format!("invalid signature: {error}"))?;
    // Prehashed and legacy signatures are both accepted, as the updater plugin does.
    public_key
        .verify(data, &signature, true)
        .map_err(|error| format!("signature check failed: {error}"))?;
    // The trusted comment is covered by the global signature that `verify` just checked, so
    // only now may it be trusted.
    check_signed_version(signature.trusted_comment(), announced_version, require_signed_version)
}

/// The update manifest itself is unsigned, so its version alone does not prove which release
/// the URL and signature belong to; the signed version is what stops an old, validly signed
/// installer from being served under a newer version number.
fn check_signed_version(trusted_comment: &str, announced: &str, require_signed_version: bool) -> Result<(), String> {
    let Some(signed) = signed_version(trusted_comment) else {
        // Older signing tools recorded no version; tolerating them is the configured default.
        return if require_signed_version { Err("signature records no version".into()) } else { Ok(()) };
    };
    // The announced version comes from the updater as canonical semver without a `v`; a `v`
    // prefix on the signed one is an equivalent spelling.
    if signed.trim_start_matches('v') == announced.trim_start_matches('v') {
        Ok(())
    } else {
        Err(format!("signed for version {signed}, announced as {announced}"))
    }
}

/// The `version:` field of a trusted comment written as tab-separated `key:value` pairs.
fn signed_version(trusted_comment: &str) -> Option<&str> {
    trusted_comment.split('\t').find_map(|field| field.strip_prefix("version:"))
}

fn decode_text(encoded: &str, what: &str) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| format!("invalid {what} encoding: {error}"))?;
    String::from_utf8(bytes).map_err(|_| format!("{what} is not UTF-8 text"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAYLOAD: &[u8] = include_bytes!("../../tests/fixtures/update/payload.bin");
    const KEY: &str = include_str!("../../tests/fixtures/update/key.pub.b64");
    const OTHER_KEY: &str = include_str!("../../tests/fixtures/update/other-key.pub.b64");
    /// Trusted comment carries `version:1.2.3`.
    const VERSIONED: &str = include_str!("../../tests/fixtures/update/versioned.sig");
    /// Trusted comment carries no version.
    const UNVERSIONED: &str = include_str!("../../tests/fixtures/update/unversioned.sig");

    #[test]
    fn accepts_a_valid_signature() {
        assert_eq!(verify(PAYLOAD, VERSIONED, KEY, "1.2.3", true), Ok(()));
        assert_eq!(verify(PAYLOAD, VERSIONED, KEY, "v1.2.3", false), Ok(()));
    }

    #[test]
    fn rejects_a_tampered_byte() {
        let mut tampered = PAYLOAD.to_vec();
        tampered[PAYLOAD.len() / 2] ^= 1;
        assert!(verify(&tampered, VERSIONED, KEY, "1.2.3", false).is_err());
    }

    #[test]
    fn rejects_another_public_key() {
        assert!(verify(PAYLOAD, VERSIONED, OTHER_KEY, "1.2.3", false).is_err());
    }

    #[test]
    fn rejects_a_different_announced_version() {
        let error = verify(PAYLOAD, VERSIONED, KEY, "1.2.4", false).unwrap_err();
        assert!(error.contains("1.2.3"), "{error}");
    }

    #[test]
    fn a_missing_signed_version_fails_only_when_required() {
        assert_eq!(verify(PAYLOAD, UNVERSIONED, KEY, "9.9.9", false), Ok(()));
        assert!(verify(PAYLOAD, UNVERSIONED, KEY, "9.9.9", true).is_err());
    }

    #[test]
    fn rejects_corrupt_encodings() {
        assert!(verify(PAYLOAD, "not base64!", KEY, "1.2.3", false).is_err());
        assert!(verify(PAYLOAD, VERSIONED, "not base64!", "1.2.3", false).is_err());
        // Valid base64 that is not UTF-8 text.
        assert!(verify(PAYLOAD, "/w==", KEY, "1.2.3", false).is_err());
    }

    #[test]
    fn reads_the_version_field_of_a_trusted_comment() {
        assert_eq!(signed_version("timestamp:1\tfile:a.exe\tversion:0.8.2"), Some("0.8.2"));
        assert_eq!(signed_version("timestamp:1\tfile:a.exe"), None);
    }
}

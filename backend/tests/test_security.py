import pytest
from cryptography.fernet import InvalidToken

import security


def test_round_trip():
    key = "sk-ant-" + "A" * 40
    assert security.decrypt_key(security.encrypt_key(key)) == key


def test_ciphertext_does_not_contain_the_plaintext():
    key = "sk-supersecret-value"
    assert key.encode() not in security.encrypt_key(key)


def test_encryption_is_non_deterministic():
    key = "sk-" + "B" * 40
    assert security.encrypt_key(key) != security.encrypt_key(key)


def test_tampered_ciphertext_is_rejected():
    token = bytearray(security.encrypt_key("sk-" + "C" * 40))
    token[-1] ^= 0xFF
    with pytest.raises(InvalidToken):
        security.decrypt_key(bytes(token))


def test_ciphertext_from_a_different_master_key_is_rejected():
    from cryptography.fernet import Fernet

    other = Fernet(Fernet.generate_key())
    with pytest.raises(InvalidToken):
        security.decrypt_key(other.encrypt(b"sk-someone-elses-key"))


def test_unicode_survives_the_round_trip():
    key = "sk-café-ключ-🔑"
    assert security.decrypt_key(security.encrypt_key(key)) == key

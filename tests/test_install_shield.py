"""Direct-mode tests for InstallShield escrow and SLA consensus."""

import hashlib
import json
from datetime import datetime, timezone

import pytest


CONTRACT = "contracts/install_shield.py"
ONE_GEN = 10**18
BASE_TIME = "2030-01-01T00:00:00Z"


def address_hex(raw_address: bytes) -> str:
    """Convert a direct-mode address fixture to the contract input format."""
    return "0x" + raw_address.hex()


def timestamp(iso_value: str) -> int:
    """Convert an ISO timestamp to Unix seconds for deadline assertions."""
    return int(datetime.fromisoformat(iso_value.replace("Z", "+00:00")).replace(tzinfo=timezone.utc).timestamp())


def deploy_at(direct_vm, direct_deploy):
    """Deploy with a stable transaction timestamp for expiry tests."""
    direct_vm.warp(BASE_TIME)
    return direct_deploy(CONTRACT)


def fund_installation(direct_vm, contract, client, installer, expires_at):
    """Create the standard one-GEN installation used by lifecycle tests."""
    direct_vm.sender = client
    direct_vm.value = ONE_GEN
    return contract.create_installation(
        address_hex(installer),
        "8 cameras, 5MP minimum, 8-channel NVR, remote health logs enabled",
        expires_at,
    )


def mock_verdict(direct_vm, status: str, confidence_bps: int = 9500) -> None:
    """Mock the auditor response returned by both leader and validator calls."""
    direct_vm.mock_llm(
        r".*Return JSON only with this exact shape.*",
        json.dumps(
            {
                "status": status,
                "confidence_bps": confidence_bps,
                "reason": "Evidence matches the stated installation requirements.",
            }
        ),
    )


def test_create_installation_locks_exact_atto_units(
    direct_vm, direct_deploy, direct_alice, direct_bob
):
    contract = deploy_at(direct_vm, direct_deploy)
    install_id = fund_installation(
        direct_vm,
        contract,
        direct_alice,
        direct_bob,
        timestamp(BASE_TIME) + 3600,
    )

    installation = contract.get_installation(install_id)
    accounting = contract.get_accounting()

    assert install_id == 1
    assert installation["status"] == "FUNDED"
    assert installation["amount_atto"] == str(ONE_GEN)
    assert installation["expires_at"] == timestamp(BASE_TIME) + 3600
    assert accounting["atto_scale"] == 10**18
    assert accounting["bps_scale"] == 10_000
    assert accounting["escrow_balance_atto"] == str(ONE_GEN)
    assert accounting["accounting_invariant"] is True


def test_client_cannot_verify_or_claim_unilaterally(
    direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie
):
    contract = deploy_at(direct_vm, direct_deploy)
    install_id = fund_installation(
        direct_vm,
        contract,
        direct_alice,
        direct_bob,
        timestamp(BASE_TIME) + 3600,
    )

    direct_vm.sender = direct_alice
    direct_vm.value = 0
    with direct_vm.expect_revert("Only the installer"):
        contract.verify_installation(install_id, "forged diagnostics")

    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("No claimable funds"):
        contract.claim_funds()

    assert contract.get_installation(install_id)["status"] == "FUNDED"
    assert contract.get_accounting()["escrow_balance_atto"] == str(ONE_GEN)


def test_verification_uses_dynamic_sha256_fence_and_releases_only_after_pass(
    direct_vm, direct_deploy, direct_alice, direct_bob
):
    contract = deploy_at(direct_vm, direct_deploy)
    install_id = fund_installation(
        direct_vm,
        contract,
        direct_alice,
        direct_bob,
        timestamp(BASE_TIME) + 3600,
    )
    diagnostics = "NVR channels 1-8 online; cameras report 5MP; health API status OK"
    sla = contract.get_installation(install_id)["sla_spec"]
    expected_digest = hashlib.sha256((sla + "\n" + diagnostics).encode("utf-8")).hexdigest()
    prompts = []
    original_match = direct_vm._match_llm_mock

    def capture_prompt(prompt: str):
        prompts.append(prompt)
        return original_match(prompt)

    direct_vm._match_llm_mock = capture_prompt
    mock_verdict(direct_vm, "PASS")
    direct_vm.sender = direct_bob
    direct_vm.value = 0
    result = contract.verify_installation(install_id, diagnostics)

    assert result == "PASS"
    assert len(prompts) == 1
    assert "<installshield-evidence-" + expected_digest + ">" in prompts[0]
    assert "</installshield-evidence-" + expected_digest + ">" in prompts[0]

    installation = contract.get_installation(install_id)
    assert installation["status"] == "VERIFIED"
    assert installation["amount_atto"] == "0"
    assert installation["diagnostics_digest"] == expected_digest
    assert contract.get_claimable(address_hex(direct_bob)) == str(ONE_GEN)
    assert contract.get_accounting()["escrow_balance_atto"] == "0"
    assert contract.get_accounting()["accounting_invariant"] is True


def test_leader_and_validator_must_agree_on_status(
    direct_vm, direct_deploy, direct_alice, direct_bob
):
    contract = deploy_at(direct_vm, direct_deploy)
    install_id = fund_installation(
        direct_vm,
        contract,
        direct_alice,
        direct_bob,
        timestamp(BASE_TIME) + 3600,
    )
    mock_verdict(direct_vm, "PASS")
    direct_vm.sender = direct_bob
    direct_vm.value = 0
    contract.verify_installation(install_id, "All required cameras and NVR diagnostics are online")

    direct_vm.clear_mocks()
    mock_verdict(direct_vm, "FAIL")
    assert direct_vm.run_validator() is False


def test_verification_prompt_demands_authenticated_device_diagnostics(
    direct_vm, direct_deploy, direct_alice, direct_bob
):
    contract = deploy_at(direct_vm, direct_deploy)
    install_id = fund_installation(
        direct_vm,
        contract,
        direct_alice,
        direct_bob,
        timestamp(BASE_TIME) + 3600,
    )
    prompts = []
    original_match = direct_vm._match_llm_mock

    def capture_prompt(prompt: str):
        prompts.append(prompt)
        return original_match(prompt)

    direct_vm._match_llm_mock = capture_prompt
    mock_verdict(direct_vm, "PASS")
    direct_vm.sender = direct_bob
    direct_vm.value = 0
    contract.verify_installation(
        install_id, "NVR channels 1-8 online; cameras report 5MP; health API status OK"
    )

    assert len(prompts) == 1
    prompt = prompts[0]
    # The trust model must force the auditor to reject generic prose and only
    # accept hardware-specific, authenticated device diagnostics.
    assert "AUTHENTICATED DEVICE DIAGNOSTICS" in prompt
    assert "SERIAL NUMBER" in prompt
    assert "MAC ADDRESS" in prompt
    assert "ACTIVE STREAM STATUS" in prompt
    assert "Dahua" in prompt and "Hikvision" in prompt


def test_verification_attempts_are_capped_to_prevent_grinding(
    direct_vm, direct_deploy, direct_alice, direct_bob
):
    contract = deploy_at(direct_vm, direct_deploy)
    install_id = fund_installation(
        direct_vm,
        contract,
        direct_alice,
        direct_bob,
        timestamp(BASE_TIME) + 3600,
    )
    # Each rejected submission keeps the installation non-terminal, which is the
    # grinding vector: an installer could resubmit until the nondeterministic
    # auditor eventually returns PASS. The MAX_ATTEMPTS cap closes that door.
    mock_verdict(direct_vm, "FAIL")
    direct_vm.sender = direct_bob
    direct_vm.value = 0

    for expected_attempt in range(1, 4):
        assert contract.verify_installation(install_id, "Generic prose evidence") == "FAIL"
        installation = contract.get_installation(install_id)
        assert installation["status"] == "REJECTED"
        assert installation["verification_attempts"] == expected_attempt
        assert installation["attempts_remaining"] == 3 - expected_attempt

    # The fourth submission must revert before any LLM work runs, and the escrow
    # must remain intact and reclaimable by the client.
    with direct_vm.expect_revert("Verification attempt limit"):
        contract.verify_installation(install_id, "One more roll of the dice")

    installation = contract.get_installation(install_id)
    assert installation["verification_attempts"] == 3
    assert installation["amount_atto"] == str(ONE_GEN)
    assert contract.get_accounting()["escrow_balance_atto"] == str(ONE_GEN)
    assert contract.get_accounting()["accounting_invariant"] is True


def test_attempt_cap_still_allows_a_passing_verification(
    direct_vm, direct_deploy, direct_alice, direct_bob
):
    contract = deploy_at(direct_vm, direct_deploy)
    install_id = fund_installation(
        direct_vm,
        contract,
        direct_alice,
        direct_bob,
        timestamp(BASE_TIME) + 3600,
    )
    # Two rejected attempts, then a PASS on the third (final) allowed attempt
    # must still release the funds -- the cap gates grinding, not legitimate use.
    mock_verdict(direct_vm, "FAIL")
    direct_vm.sender = direct_bob
    direct_vm.value = 0
    assert contract.verify_installation(install_id, "Generic prose one") == "FAIL"
    assert contract.verify_installation(install_id, "Generic prose two") == "FAIL"

    direct_vm.clear_mocks()
    mock_verdict(direct_vm, "PASS")
    assert (
        contract.verify_installation(
            install_id,
            "Hikvision NVR serial DS-7608, MAC AA:BB:CC:DD:EE:FF, channels 1-8 streaming",
        )
        == "PASS"
    )

    installation = contract.get_installation(install_id)
    assert installation["status"] == "VERIFIED"
    assert installation["verification_attempts"] == 3
    assert contract.get_claimable(address_hex(direct_bob)) == str(ONE_GEN)
    assert contract.get_accounting()["accounting_invariant"] is True


def test_low_confidence_pass_is_normalized_to_rejected(
    direct_vm, direct_deploy, direct_alice, direct_bob
):
    contract = deploy_at(direct_vm, direct_deploy)
    install_id = fund_installation(
        direct_vm,
        contract,
        direct_alice,
        direct_bob,
        timestamp(BASE_TIME) + 3600,
    )
    mock_verdict(direct_vm, "PASS", confidence_bps=7499)
    direct_vm.sender = direct_bob
    direct_vm.value = 0

    assert contract.verify_installation(install_id, "Partial diagnostics") == "FAIL"
    installation = contract.get_installation(install_id)
    assert installation["status"] == "REJECTED"
    assert installation["amount_atto"] == str(ONE_GEN)
    assert contract.get_accounting()["escrow_balance_atto"] == str(ONE_GEN)


def test_reclaim_funds_requires_expiry_and_refunds_the_client(
    direct_vm, direct_deploy, direct_alice, direct_bob
):
    contract = deploy_at(direct_vm, direct_deploy)
    deadline = timestamp(BASE_TIME) + 60
    install_id = fund_installation(
        direct_vm, contract, direct_alice, direct_bob, deadline
    )

    direct_vm.sender = direct_alice
    direct_vm.value = 0
    with direct_vm.expect_revert("has not expired"):
        contract.reclaim_funds(install_id)

    direct_vm.warp("2030-01-01T00:01:01Z")
    contract.reclaim_funds(install_id)

    installation = contract.get_installation(install_id)
    assert installation["status"] == "RECLAIMED"
    assert installation["amount_atto"] == "0"
    assert contract.get_claimable(address_hex(direct_alice)) == str(ONE_GEN)
    assert contract.get_accounting()["escrow_balance_atto"] == "0"
    assert contract.get_accounting()["total_reclaimed_atto"] == str(ONE_GEN)
    assert contract.get_accounting()["accounting_invariant"] is True


def test_reclaim_funds_is_client_only_after_expiry(
    direct_vm, direct_deploy, direct_alice, direct_bob
):
    contract = deploy_at(direct_vm, direct_deploy)
    install_id = fund_installation(
        direct_vm,
        contract,
        direct_alice,
        direct_bob,
        timestamp(BASE_TIME) + 60,
    )
    direct_vm.warp("2030-01-01T00:01:01Z")
    direct_vm.sender = direct_bob

    with direct_vm.expect_revert("Only the client"):
        contract.reclaim_funds(install_id)

    assert contract.get_installation(install_id)["status"] == "FUNDED"


def test_claim_funds_effects_and_errored_message_rollback(
    direct_vm, direct_deploy, direct_alice, direct_bob
):
    contract = deploy_at(direct_vm, direct_deploy)
    install_id = fund_installation(
        direct_vm,
        contract,
        direct_alice,
        direct_bob,
        timestamp(BASE_TIME) + 3600,
    )
    mock_verdict(direct_vm, "PASS")
    direct_vm.sender = direct_bob
    direct_vm.value = 0
    contract.verify_installation(install_id, "All channels online")
    contract.claim_funds()

    accounting = contract.get_accounting()
    assert accounting["total_claimable_atto"] == "0"
    assert accounting["total_claimed_atto"] == str(ONE_GEN)

    direct_vm.sender = direct_bob
    direct_vm.value = ONE_GEN
    contract.__on_errored_message__()

    accounting = contract.get_accounting()
    assert accounting["total_claimable_atto"] == str(ONE_GEN)
    assert accounting["total_claimed_atto"] == "0"
    assert contract.get_claimable(address_hex(direct_bob)) == str(ONE_GEN)
    assert accounting["accounting_invariant"] is True


def test_error_hook_rejects_unrecognized_value(
    direct_vm, direct_deploy, direct_bob
):
    contract = deploy_at(direct_vm, direct_deploy)
    direct_vm.sender = direct_bob
    direct_vm.value = ONE_GEN

    with direct_vm.expect_revert("Unknown failed payout"):
        contract.__on_errored_message__()


@pytest.mark.parametrize(
    "installer,sla,expires_at",
    [
        ("not-an-address", "Valid SLA", timestamp(BASE_TIME) + 60),
        ("0x0000000000000000000000000000000000000000", "Valid SLA", timestamp(BASE_TIME) + 60),
        ("0x2222222222222222222222222222222222222222", "", timestamp(BASE_TIME) + 60),
        ("0x2222222222222222222222222222222222222222", "Valid SLA", timestamp(BASE_TIME) - 1),
    ],
)
def test_creation_rejects_invalid_installation_inputs(
    direct_vm, direct_deploy, direct_alice, installer, sla, expires_at
):
    contract = deploy_at(direct_vm, direct_deploy)
    direct_vm.sender = direct_alice
    direct_vm.value = ONE_GEN

    with direct_vm.expect_revert():
        contract.create_installation(installer, sla, expires_at)

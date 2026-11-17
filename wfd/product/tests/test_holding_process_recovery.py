"""Real isolated writer termination, not device/power-loss durability evidence."""
import json
import subprocess
import sys
import time
from pathlib import Path

from test_r1_data_only import request, scalar_output


def test_killed_writer_recovers_in_fresh_process_with_same_identity_and_observation(tmp_path):
    doc = request([scalar_output("metric", "synthetic.process.recovery", "10")], "killed-writer")
    document = tmp_path / "input.json"
    document.write_text(json.dumps(doc))
    marker = tmp_path / "receipt-ready.json"
    tests = Path(__file__).resolve().parent
    code = """
import json, sys, time
from pathlib import Path
sys.path[:0] = [sys.argv[1], sys.argv[2]]
from test_r1_data_only import make_data_service
root = Path(sys.argv[3])
service = make_data_service(root)
def pause_after_actual_immutable_receipt(record):
    # Synchronize an actual process kill at the existing post-receipt boundary.
    # Do not synthesize a receipt, commit, observation time or holding fact.
    pending = root / 'receipt-ready.pending'
    with pending.open('x') as stream:
        json.dump({'snapshot_id': record['snapshot_id']}, stream)
    pending.rename(root / 'receipt-ready.json')
    while True:
        time.sleep(0.1)
service._record_formal_holdings = pause_after_actual_immutable_receipt
service.submit(json.loads((root / 'input.json').read_text()))
raise RuntimeError('writer must be killed before continuing')
"""
    process = subprocess.Popen([sys.executable, "-I", "-c", code, str(tests), str(tests.parent), str(tmp_path)],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        deadline = time.monotonic() + 30
        while not marker.exists():
            assert process.poll() is None, process.communicate(timeout=5)
            assert time.monotonic() < deadline, "isolated writer did not reach its actual receipt boundary"
            time.sleep(0.02)
        receipts = list((tmp_path / "store/catalog/product_service/data_only_formal_publications").glob("*.json"))
        assert len(receipts) == 1
        original_receipt = receipts[0].read_bytes()
        proof = json.loads(original_receipt)
        assert proof["snapshot_id"] == json.loads(marker.read_text())["snapshot_id"]
        assert process.poll() is None
        process.kill()  # SIGKILL on POSIX; TerminateProcess on Windows. Only our isolated child.
        process.communicate(timeout=10)
        assert process.returncode != 0

        # No service object from the killed writer or live pytest parent is reused.
        recovery_code = """
import json, sys
from pathlib import Path
sys.path[:0] = [sys.argv[1], sys.argv[2]]
from test_r1_data_only import make_data_service
from wfd_sdk.product_holdings import HoldingLedger
tmp_path = Path(sys.argv[3])
doc = json.loads((tmp_path / 'input.json').read_text())
receipts = list((tmp_path / 'store/catalog/product_service/data_only_formal_publications').glob('*.json'))
assert len(receipts) == 1
original_receipt = receipts[0].read_bytes()
proof = json.loads(original_receipt)
reopened = make_data_service(tmp_path)
before = reopened.engine.head()["snapshot_id"]
assert before == proof["snapshot_id"]
ledger = HoldingLedger(reopened.root, proof["holding"]["instance_id"])
assert ledger.facts() == []
status = reopened.request_status(doc["request_identity"])
assert status["state"] == "published_formal"
assert status["holding_status"]["state"] == "pending"
assert ledger.facts() == [], "read-only status cannot perform recovery writes"
recovered = reopened.submit(doc)
assert recovered["state"] == "published_formal"
assert recovered["snapshot_id"] == before
assert recovered["holding_status"]["state"] == "recorded"
assert recovered["holding_status"]["published_readable_at"] == proof["holding"]["published_readable_at"]
assert receipts[0].read_bytes() == original_receipt
assert reopened.engine.head()["snapshot_id"] == before
facts = ledger.facts()
assert len(facts) == 1
assert reopened.submit(doc)["holding_status"] == recovered["holding_status"]
assert ledger.facts() == facts
pid = recovered["output_results"][0]["product_id"]
held = reopened.read(pid, snapshot_id=before, perspective="system_held_at",
                     at=proof["holding"]["published_readable_at"],
                     held_scope=proof["holding"]["instance_id"], usable_stage="published_readable")
assert len(held["rows"]) == 1
assert held["rows"][0]["held_at"] == proof["holding"]["published_readable_at"]
"""
        recovery = subprocess.run([sys.executable, "-I", "-c", recovery_code,
                                   str(tests), str(tests.parent), str(tmp_path)],
                                  capture_output=True, text=True, timeout=30)
        assert recovery.returncode == 0, recovery.stdout + recovery.stderr
        assert receipts[0].read_bytes() == original_receipt
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate(timeout=10)

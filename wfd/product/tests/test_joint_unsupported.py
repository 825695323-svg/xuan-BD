"""Fresh real joint volumes reject unsupported legacy operations before any write."""
from pathlib import Path
from types import SimpleNamespace
import pytest
from test_joint_volume import open_service
from wfd_sdk.state import StateError
from wfd_sdk.gc import GC
from wfd_sdk import transfer, product_bundle
from wfd_sdk.product_volume_service import WFDVolumeService
from wfd_sdk.volume_publication import LocalMirrorStateStore, VolumePublisher


def inventory(root):
    return {str(p.relative_to(root)): p.read_bytes() if p.is_file() else None
            for p in root.rglob('*')}


def test_joint_unsupported_entrypoints_leave_all_files_unchanged(tmp_path):
    service = open_service(tmp_path, new=True)
    root = service.root
    runtime = tmp_path / 'unsupported-runtime'
    package = tmp_path / 'absent-package'
    destination = tmp_path / 'absent-destination'
    binding = SimpleNamespace(mount_point=root)
    calls = [
        lambda: GC(root),
        lambda: WFDVolumeService(binding=binding, runtime_root=runtime, protocol_root=package),
        lambda: LocalMirrorStateStore(root, runtime),
        lambda: VolumePublisher(binding=binding, runtime_root=runtime),
        lambda: transfer.object_manifest(root, 'absent'),
        lambda: transfer.export_package(root, 'absent', destination),
        lambda: transfer.import_package(package, root),
        lambda: transfer.host_state(root),
        lambda: transfer.write_host_state(root, writer_host='test', writer_epoch=1, active_head=None),
        lambda: transfer.check_fast_forward(root, 'absent'),
        lambda: transfer.activate(root, 'absent', writer_host='test', writer_epoch=1),
        lambda: transfer.publish_guard(root, host='test', epoch=1),
        lambda: transfer.read_guarded(root, 'absent', None),
    ]
    for name in ['export_financial_bundle', 'export_reference_bundle',
                 'export_structured_bundle', 'export_structured_reference_bundle']:
        calls.append(lambda name=name: getattr(product_bundle, name)(
            service, [], destination, snapshot_id='absent'))
    for name in ['export_delta_bundle', 'export_structured_delta_bundle']:
        calls.append(lambda name=name: getattr(product_bundle, name)(
            service, [], destination, snapshot_id='absent',
            baseline_store=root, baseline_snapshot_id='absent'))
    for name in ['import_financial_bundle', 'import_structured_bundle']:
        calls.append(lambda name=name: getattr(product_bundle, name)(
            package, root, runtime_root=runtime))
    calls += [
        lambda: product_bundle._legacy_import(package, root, runtime),
        lambda: product_bundle.apply_delta_bundle(package, root, runtime_root=runtime, allowed_sources={}),
        lambda: product_bundle.apply_structured_delta_bundle(package, root, runtime_root=runtime),
        lambda: product_bundle.register_reference_bundle(package, root, resolvers={}),
        lambda: product_bundle.register_structured_reference_bundle(package, root, resolvers={}, runtime_root=runtime),
    ]
    before = inventory(tmp_path)
    for call in calls:
        with pytest.raises(StateError, match='JOINT_OPERATION_UNSUPPORTED'):
            call()
        assert inventory(tmp_path) == before


def test_existing_gc_object_cannot_fall_back_after_joint_initialization(tmp_path):
    root = tmp_path / 'store'
    gc = GC(root)
    open_service(tmp_path, new=True)
    before = inventory(tmp_path)
    for call in [lambda: gc.head({}), gc.plan, lambda: gc.execute({}, run_id='test')]:
        with pytest.raises(StateError, match='JOINT_OPERATION_UNSUPPORTED'):
            call()
        assert inventory(tmp_path) == before


def test_joint_mixed_or_missing_format_is_not_treated_as_legacy(tmp_path):
    service = open_service(tmp_path, new=True)
    root = service.root
    state = root / 'catalog/state.json'
    state.write_text('{}')  # Isolated ordinary malformed-format fixture, not migration.
    before = inventory(tmp_path)
    with pytest.raises(StateError, match='JOINT_LEGACY_MIXED'):
        transfer.host_state(root)
    assert inventory(tmp_path) == before
    state.unlink()
    (root / 'catalog/volume-format.json').unlink()
    before = inventory(tmp_path)
    with pytest.raises(StateError, match='JOINT_FORMAT_MISSING'):
        GC(root)
    assert inventory(tmp_path) == before

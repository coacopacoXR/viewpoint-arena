"""Shared fakes, fixtures and GLB readers.

Two seams let most of this suite run with NO OpenCascade, NO gltfpack and NO
subprocess, exactly the way capture-service's suite runs with no Whisper:

  * jobs.JobRunner is a Protocol, and main.create_app(settings, runner) takes one
    as an argument — so a test wires a fully working service around a fake that
    answers from a dict.
  * The engine is only ever touched through that runner, so a platform
    cadquery-ocp has no wheel for still gets the whole HTTP surface tested.

The tests that DO need the engine are marked `requires_engine` and say why when
they skip, rather than failing: `docker compose run --rm convert-service pytest`
runs every one of them (the image has OCP and gltfpack), and a contributor's
laptop run reports them as skipped with a reason instead of turning red for a
missing optional dependency.

The GLB readers here are deliberately hand-rolled and dependency-free. Reading
the JSON chunk and walking the node table is thirty lines, and it means the tests
assert on the FILE the client receives — after gltfpack, including the
KHR_mesh_quantization nodes it inserts — rather than on the scene graph this
service thought it wrote.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import re
import shutil
import struct
import tempfile
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from convert_service.config import Settings, load_settings
from convert_service.jobs import ConversionResult, SubprocessRunner
from convert_service.main import create_app

FIXTURES = Path(__file__).parent / "fixtures"

ASSEMBLY_STEP = FIXTURES / "assembly.step"
BOX_BREP = FIXTURES / "box.brep"

#: The fixture's own dimensions, in millimetres, Z-up as the STEP file has them.
#: scripts/make_fixtures.py builds to these numbers and the bounding-box tests
#: check them after the Y-up rotation.
ASSEMBLY_Z_UP_BOUNDS = ((0.0, 0.0, -20.0), (120.0, 80.0, 48.0))

GLTFPACK = shutil.which("gltfpack")


def engine_gap() -> str | None:
    """Why the engine cannot run here, or None when it can."""
    try:
        ocp = importlib.util.find_spec("OCP") is not None
    except (ImportError, ValueError):
        ocp = False
    if not ocp:
        return "cadquery-ocp (the OCP module) is not installed"
    if GLTFPACK is None:
        return "gltfpack is not on PATH"
    return None


#: Marks a test that converts a real file: it needs OpenCascade and gltfpack.
requires_engine = pytest.mark.skipif(
    engine_gap() is not None,
    reason=f"the conversion engine is not available here: {engine_gap()}",
)


# ─── Fakes ──────────────────────────────────────────────────────────────────


@dataclass
class FakeRunner:
    """Stands in for jobs.SubprocessRunner. Satisfies jobs.JobRunner.

    `failure` is raised instead of converting, so a test can drive any error path
    without an engine; `result_bytes` is what the response body comes back as.
    """

    result_bytes: bytes = b"glTF-fake"
    part_count: int = 3
    triangle_count: int = 12
    convert_ms: int = 7
    unique_meshes: int = 1
    node_count: int = 4
    failure: Exception | None = None
    calls: list[dict[str, Any]] = field(default_factory=list)
    delay_seconds: float = 0.0
    in_flight: int = 0

    async def run(self, source: Path, *, file_name: str, reader: str) -> ConversionResult:
        self.calls.append(
            {
                "path": Path(source),
                "suffix": Path(source).suffix,
                "bytes": Path(source).read_bytes(),
                "file_name": file_name,
                "reader": reader,
            }
        )
        if self.delay_seconds:
            await asyncio.sleep(self.delay_seconds)
        if self.failure is not None:
            raise self.failure

        handle = tempfile.NamedTemporaryFile(prefix="fake-glb-", suffix=".glb", delete=False)
        handle.write(self.result_bytes)
        handle.close()
        path = Path(handle.name)
        return ConversionResult(
            glb_path=path,
            part_count=self.part_count,
            triangle_count=self.triangle_count,
            convert_ms=self.convert_ms,
            unique_meshes=self.unique_meshes,
            node_count=self.node_count,
            cleanup=lambda: path.unlink(missing_ok=True),
        )


@dataclass
class Service:
    """A wired app plus the fake it was built with, and helpers to call it."""

    client: TestClient
    runner: FakeRunner
    settings: Settings

    def post_convert(
        self,
        body: bytes = b"ISO-10303-21;",
        *,
        file_name: str | None = "bracket.step",
        headers: dict[str, str] | None = None,
    ) -> Any:
        request_headers = dict(headers or {})
        if file_name is not None:
            request_headers["X-File-Name"] = file_name
        return self.client.post(
            "/convert",
            content=body,
            headers=request_headers,
        )


@pytest.fixture
def make_service() -> Callable[..., Service]:
    """Build a service from an environment mapping and/or a replacement runner."""

    def build(
        *,
        env: dict[str, str] | None = None,
        runner: FakeRunner | None = None,
    ) -> Service:
        resolved_runner = runner if runner is not None else FakeRunner()
        settings = load_settings(env or {})
        app = create_app(settings, resolved_runner)
        return Service(client=TestClient(app), runner=resolved_runner, settings=settings)

    return build


@pytest.fixture
def make_app() -> Callable[..., "object"]:
    """Build just the FastAPI app, for tests that need their own TestClient.

    make_service is the usual entry point; this one exists because
    TestClient(raise_server_exceptions=False) — what a real caller experiences
    when a handler raises — has to be chosen by the test, not by the fixture.
    """

    def build(*, env: dict[str, str] | None = None, runner: FakeRunner | None = None):
        resolved_runner = runner if runner is not None else FakeRunner()
        return create_app(load_settings(env or {}), resolved_runner)

    return build


@pytest.fixture
def service(make_service: Callable[..., Service]) -> Iterator[Service]:
    """The default service: no secret, a fake runner that always succeeds."""
    bundle = make_service()
    with bundle.client:
        yield bundle


@pytest.fixture
def client(service: Service) -> TestClient:
    return service.client


@pytest.fixture
def settings() -> Settings:
    """Settings from the documented defaults, with no environment at all."""
    return load_settings({})


# ─── The real engine, for the tests that need it ────────────────────────────


@pytest.fixture
def convert_file() -> Callable[..., tuple[Path, ConversionResult]]:
    """Convert a real file through the production runner.

    Returns (glb_path, result). The GLB lives in the runner's job directory and
    is removed by `result.cleanup()`, which the fixture registers with pytest so
    a test cannot leak it by forgetting.
    """

    def run(
        source: Path,
        *,
        file_name: str | None = None,
        env: dict[str, str] | None = None,
    ) -> tuple[Path, ConversionResult]:
        settings = load_settings(env or {})
        runner = SubprocessRunner(settings)
        name = file_name if file_name is not None else source.name
        result = asyncio.run(runner.run(Path(source), file_name=name, reader=_reader_of(name)))
        return result.glb_path, result

    return run


def _reader_of(file_name: str) -> str:
    from convert_service import formats

    reader = formats.reader_for(file_name)
    if reader is None:
        raise AssertionError(f"{file_name!r} is not a CAD filename")
    return reader


# ─── Reading a GLB ──────────────────────────────────────────────────────────

GLB_MAGIC = 0x46546C67
CHUNK_JSON = 0x4E4F534A


def read_glb(path: Path) -> dict[str, Any]:
    """The JSON chunk of a GLB, parsed. Fails loudly if it is not a GLB."""
    data = Path(path).read_bytes()
    assert len(data) >= 20, f"{path} is too short to be a GLB"
    magic, version, length = struct.unpack("<III", data[:12])
    assert magic == GLB_MAGIC, f"{path} does not start with the glTF magic"
    assert version == 2, f"{path} is glTF {version}, not 2"
    assert length == len(data), f"{path} declares {length} bytes and has {len(data)}"
    chunk_length, chunk_type = struct.unpack("<II", data[12:20])
    assert chunk_type == CHUNK_JSON, f"{path}'s first chunk is not JSON"
    return json.loads(data[20 : 20 + chunk_length])


@dataclass(frozen=True)
class TreeNode:
    """One node of the tree a client would build, names and all."""

    name: str
    mesh: int | None
    matrix: tuple[float, ...]
    children: tuple["TreeNode", ...]

    def render(self, depth: int = 0) -> list[str]:
        kind = "MESH" if self.mesh is not None else "GROUP"
        head = f"{'  ' * depth}{self.name or '<unnamed>'} [{kind}]"
        lines = [head]
        for child in self.children:
            lines.extend(child.render(depth + 1))
        return lines


IDENTITY_MATRIX = (1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0)


def scene_tree(gltf: dict[str, Any]) -> TreeNode:
    """The scene's node tree, as a single root.

    A glTF scene can have several roots; this wraps them in an unnamed node so a
    caller can compare trees without caring. That wrapper is exactly what
    GLTFLoader does — `gltf.scene` is a THREE.Scene holding the scene's roots —
    and what cadResultToGroup's unnamed root group is on the browser side.
    """
    scene = gltf["scenes"][gltf.get("scene", 0)]
    roots = tuple(_node(gltf, index) for index in scene.get("nodes") or [])
    return TreeNode(name=gltf["scenes"][gltf.get("scene", 0)].get("name") or "", mesh=None,
                    matrix=IDENTITY_MATRIX, children=roots)


def _node(gltf: dict[str, Any], index: int) -> TreeNode:
    node = gltf["nodes"][index]
    return TreeNode(
        name=node.get("name") or "",
        mesh=node.get("mesh"),
        matrix=_node_matrix(node),
        children=tuple(_node(gltf, child) for child in node.get("children") or ()),
    )


def _node_matrix(node: dict[str, Any]) -> tuple[float, ...]:
    """A node's matrix, from `matrix` or from TRS.

    gltfpack writes TRS rather than a matrix once it quantizes: the
    dequantisation scale lands on a per-mesh node as `scale`. Reading only
    `matrix` would report those nodes as identity and put every part of a
    compressed GLB in the wrong place.
    """
    if node.get("matrix"):
        return tuple(float(value) for value in node["matrix"])

    translation = node.get("translation") or [0.0, 0.0, 0.0]
    rotation = node.get("rotation") or [0.0, 0.0, 0.0, 1.0]
    scale = node.get("scale") or [1.0, 1.0, 1.0]
    return _matrix_of_trs(translation, rotation, scale)


def _matrix_of_trs(
    translation: list[float], rotation: list[float], scale: list[float]
) -> tuple[float, ...]:
    x, y, z, w = rotation
    # Column-major, matching glTF: rotation matrix R times the scale on each
    # column, then the translation in the fourth.
    rotation_columns = (
        (1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)),
        (2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w)),
        (2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)),
    )
    matrix = [0.0] * 16
    for column in range(3):
        for row in range(3):
            matrix[column * 4 + row] = rotation_columns[column][row] * scale[column]
    matrix[12], matrix[13], matrix[14], matrix[15] = translation[0], translation[1], translation[2], 1.0
    return tuple(matrix)


def _multiply(a: tuple[float, ...], b: tuple[float, ...]) -> tuple[float, ...]:
    """Column-major 4×4 product a·b."""
    return tuple(
        sum(a[k * 4 + row] * b[column * 4 + k] for k in range(4))
        for column in range(4)
        for row in range(4)
    )


def _apply(matrix: tuple[float, ...], point: tuple[float, float, float]) -> tuple[float, float, float]:
    x, y, z = point
    return (
        matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
        matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
        matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
    )


def part_bounds(gltf: dict[str, Any]) -> list[tuple[str, tuple[float, ...], tuple[float, ...]]]:
    """One (name, min, max) per part, depth-first, in WORLD space.

    The name is the inherited one, i.e. what the model tree shows. This is what
    lets a test say "the six bolts are in six different places" rather than "there
    are six nodes", which is the difference between checking instancing and
    checking a node count.

    Bounds come from each POSITION accessor's min/max pushed through the
    accumulated node matrices — what a viewer does without reading vertex data —
    so a part placed by a wrong matrix shows up here even though its own accessor
    looks fine. That includes gltfpack's quantization matrices, which is why
    _node_matrix reads TRS as well as `matrix`.
    """
    meshes = gltf.get("meshes") or []
    accessors = gltf.get("accessors") or []
    parts: list[tuple[str, tuple[float, ...], tuple[float, ...]]] = []

    def walk(node: TreeNode, parent: tuple[float, ...], inherited: str) -> None:
        matrix = _multiply(parent, node.matrix)
        name = node.name or inherited
        if node.mesh is not None:
            low = [float("inf")] * 3
            high = [float("-inf")] * 3
            for primitive in meshes[node.mesh]["primitives"]:
                accessor = accessors[primitive["attributes"]["POSITION"]]
                for corner in _corners(accessor.get("min"), accessor.get("max")):
                    point = _apply(matrix, corner)
                    for axis in range(3):
                        low[axis] = min(low[axis], point[axis])
                        high[axis] = max(high[axis], point[axis])
            parts.append((name, tuple(low), tuple(high)))
        for child in node.children:
            walk(child, matrix, name)

    walk(scene_tree(gltf), IDENTITY_MATRIX, "")
    return parts


def _corners(
    minimum: list[float] | None, maximum: list[float] | None
) -> Iterator[tuple[float, float, float]]:
    if not minimum or not maximum:
        return
    for x in (minimum[0], maximum[0]):
        for y in (minimum[1], maximum[1]):
            for z in (minimum[2], maximum[2]):
                yield (x, y, z)


def world_bounds(gltf: dict[str, Any]) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
    """The whole scene's axis-aligned bounds in world space."""
    low = [float("inf")] * 3
    high = [float("-inf")] * 3
    for _, part_low, part_high in part_bounds(gltf):
        for axis in range(3):
            low[axis] = min(low[axis], part_low[axis])
            high[axis] = max(high[axis], part_high[axis])
    return (tuple(low), tuple(high))  # type: ignore[return-value]


def mesh_usage(gltf: dict[str, Any]) -> dict[int, int]:
    """How many nodes reference each mesh index — the instancing evidence."""
    usage: dict[int, int] = {}

    def walk(node: TreeNode) -> None:
        if node.mesh is not None:
            usage[node.mesh] = usage.get(node.mesh, 0) + 1
        for child in node.children:
            walk(child)

    walk(scene_tree(gltf))
    return usage


def part_names(gltf: dict[str, Any]) -> list[str]:
    """The name of every mesh-carrying node, in depth-first order.

    A node with no name of its own is reported as its nearest named ancestor's
    name, which is what the app shows: gltfpack puts a mesh on an unnamed child
    of the named node once it quantizes, and buildSceneTree's
    collapseSingleChildGroups hands the parent's name to a child whose own name
    is a placeholder.
    """
    names: list[str] = []

    def walk(node: TreeNode, inherited: str) -> None:
        name = node.name or inherited
        if node.mesh is not None:
            names.append(name)
        for child in node.children:
            walk(child, name)

    walk(scene_tree(gltf), "")
    return names


def material_colours(gltf: dict[str, Any]) -> list[tuple[float, ...]]:
    """Every material's baseColorFactor, in glTF's LINEAR space."""
    return [
        tuple(material.get("pbrMetallicRoughness", {}).get("baseColorFactor") or ())
        for material in gltf.get("materials") or []
    ]


def effective_tree(gltf: dict[str, Any]) -> tuple:
    """The assembly tree the way the app's model tree shows it.

    Returned as nested `(name, kind, children)` tuples, `kind` being "PART" for a
    node with geometry and "GROUP" for one without — the two values
    buildSceneTree puts in SceneNode.type.

    Three things are folded away, and each one is a rule the app already applies
    rather than a convenience for this test:

      * an unnamed node that carries no mesh — gltfpack inserts one per mesh to
        hold the KHR_mesh_quantization transform, and GLTFLoader would show it as
        a "Group N" row;
      * a nameless part inherits the nearest name above it, which is what
        buildSceneTree's placeholder rule does ("Mesh N" / "Group N");
      * a chain of single-child groups collapses to its last member, exactly as
        collapseSingleChildGroups in utils/modelLoader.ts does — including its
        rule that the surviving node keeps the OUTER name when the inner one is a
        placeholder. This is what turns CAD's Group("Base Plate") > Mesh("Base
        Plate") into one row, and it is why a converted file and a
        browser-imported one show the same tree.

    Comparing this rather than the raw node table is the point: the raw table has
    a level per gltfpack artefact, and what a reviewer or a pin cares about is the
    tree the app builds.
    """
    result: list[tuple] = []
    _fold(scene_tree(gltf), "", result)
    assert len(result) == 1, f"expected one scene root, got {result}"
    return _collapse(result[0])


def _fold(node: TreeNode, inherited: str, out: list[tuple]) -> None:
    name = node.name or inherited
    kind = "PART" if node.mesh is not None else "GROUP"

    if not node.name and inherited and node.mesh is None:
        # An unnamed pass-through group: its children belong to the level above.
        for child in node.children:
            _fold(child, inherited, out)
        return

    children: list[tuple] = []
    for child in node.children:
        _fold(child, name, children)
    out.append((name, kind, children))


#: buildSceneTree names an object with no usable name after its type and index.
PLACEHOLDER_NAME = re.compile(r"^(Mesh|Group) \d+$")


def _collapse(node: tuple) -> tuple:
    """collapseSingleChildGroups, applied to one folded node."""
    name, kind, children = node
    while kind == "GROUP" and len(children) == 1:
        child_name, child_kind, child_children = children[0]
        # The app keeps the outer name when the inner one is a placeholder, so a
        # collapsed group does not lose the name the file gave it.
        if not child_name or PLACEHOLDER_NAME.match(child_name):
            child_name = name
        name, kind, children = child_name, child_kind, child_children
    return (name, kind, [_collapse(child) for child in children])

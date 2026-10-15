"""What a real conversion produces, read back out of the GLB.

Everything here runs the production path — SubprocessRunner, the worker, OCP,
gltfpack — and asserts on the FILE, not on the scene graph this service thought it
wrote. That is the only way to catch gltfpack restructuring the tree, which is
the failure mode that would silently move every pin in a room.

The fixture is scripts/make_fixtures.py's `assembly.step`:

    Frame Assembly
    ├── Base Plate      120 × 80 × 8   red      (1 instance)
    ├── Corner Joint                            (2 instances, one turned 90°)
    │   ├── Corner Bracket  12 × 40 × 40  green
    │   ├── M6 Bolt         r3 × 20       blue
    │   └── M6 Bolt
    ├── M6 Bolt                                 (2 loose instances)
    └── M6 Bolt

Nine solids, three distinct shapes, three colours, two levels of nesting.
"""

from __future__ import annotations

import asyncio
import json
import struct
from dataclasses import dataclass
from pathlib import Path

import pytest

from convert_service.config import load_settings
from convert_service.errors import ConvertUnreadable
from convert_service.jobs import SubprocessRunner
from conftest import (  # noqa: F401  (fixtures and readers live in conftest)
    ASSEMBLY_STEP,
    ASSEMBLY_Z_UP_BOUNDS,
    BOX_BREP,
    effective_tree,
    material_colours,
    mesh_usage,
    part_bounds,
    part_names,
    read_glb,
    requires_engine,
    world_bounds,
)

pytestmark = requires_engine

# The fixture's expected tree, after the app's own collapsing rules (see
# effective_tree). This is the parity contract: a browser importing assembly.step
# through occt-import-js + cadResultToGroup + buildSceneTree shows exactly these
# rows, in this order. scripts/parity.mjs checks the same thing against the real
# browser code rather than against this literal.
EXPECTED_TREE = (
    "Frame Assembly",
    "GROUP",
    [
        ("Base Plate", "PART", []),
        (
            "Corner Joint",
            "GROUP",
            [
                ("Corner Bracket", "PART", []),
                ("M6 Bolt", "PART", []),
                ("M6 Bolt", "PART", []),
            ],
        ),
        (
            "Corner Joint",
            "GROUP",
            [
                ("Corner Bracket", "PART", []),
                ("M6 Bolt", "PART", []),
                ("M6 Bolt", "PART", []),
            ],
        ),
        ("M6 Bolt", "PART", []),
        ("M6 Bolt", "PART", []),
    ],
)

# sRGB values written into the fixture by scripts/make_fixtures.py.
PLATE_SRGB = (0.80, 0.10, 0.10)
BRACKET_SRGB = (0.20, 0.70, 0.30)
BOLT_SRGB = (0.15, 0.25, 0.85)


def srgb_to_linear(channel: float) -> float:
    """The same curve THREE.Color.setRGB(..., SRGBColorSpace) applies."""
    if channel <= 0.04045:
        return channel / 12.92
    return ((channel + 0.055) / 1.055) ** 2.4


@dataclass(frozen=True)
class Converted:
    gltf: dict
    glb_bytes: bytes
    part_count: int
    triangle_count: int
    unique_meshes: int
    node_count: int
    convert_ms: int


def _convert_once(source: Path, reader: str) -> Converted:
    runner = SubprocessRunner(load_settings({}))
    result = asyncio.run(runner.run(source, file_name=source.name, reader=reader))
    try:
        return Converted(
            gltf=read_glb(result.glb_path),
            glb_bytes=result.glb_path.read_bytes(),
            part_count=result.part_count,
            triangle_count=result.triangle_count,
            unique_meshes=result.unique_meshes,
            node_count=result.node_count,
            convert_ms=result.convert_ms,
        )
    finally:
        result.cleanup()


@pytest.fixture(scope="module")
def assembly() -> Converted:
    """The assembly fixture, converted once for the whole module.

    Module scope because a conversion pays for importing OCP in a fresh
    subprocess, and none of these tests mutate the result.
    """
    assert ASSEMBLY_STEP.is_file(), (
        f"{ASSEMBLY_STEP} is missing — regenerate it with "
        f"`docker compose run --rm convert-service python scripts/make_fixtures.py`"
    )
    return _convert_once(ASSEMBLY_STEP, "step")


@dataclass(frozen=True)
class Uncompressed:
    """The same conversion written straight out of gltf.py, before gltfpack."""

    path: Path
    gltf: dict
    size: int


@pytest.fixture(scope="module")
def uncompressed(tmp_path_factory) -> Uncompressed:
    """Convert in-process and write the GLB with no compression pass.

    Two things need this: a size comparison that means something (compressed
    against the SAME scene uncompressed, rather than against a guess), and proof
    that gltfpack did not restructure the tree — which is only checkable by
    looking at both.
    """
    from convert_service import cad
    from convert_service.gltf import write_glb

    conversion = cad.convert(ASSEMBLY_STEP, reader="step", file_name=ASSEMBLY_STEP.name)
    path = tmp_path_factory.mktemp("uncompressed") / "model.glb"
    write_glb(
        conversion.roots,
        path,
        scene_name=conversion.scene_name,
        generator="convert-service tests",
    )
    return Uncompressed(path=path, gltf=read_glb(path), size=path.stat().st_size)


@pytest.fixture(scope="module")
def brep() -> Converted:
    assert BOX_BREP.is_file(), f"{BOX_BREP} is missing — see scripts/make_fixtures.py"
    return _convert_once(BOX_BREP, "brep")


# ─── The file itself ────────────────────────────────────────────────────────


def test_the_answer_is_a_glb_the_app_can_load(assembly):
    magic, version, length = struct.unpack("<III", assembly.glb_bytes[:12])

    assert magic == 0x46546C67, "not a binary glTF"
    assert version == 2
    assert length == len(assembly.glb_bytes), "the GLB is truncated or padded wrong"
    assert assembly.gltf["asset"]["version"] == "2.0"
    # modelLoader.ts sets a MeshoptDecoder on its GLTFLoader, so a meshopt file is
    # what the app already knows how to read — no new client-side dependency.
    assert "EXT_meshopt_compression" in assembly.gltf["extensionsUsed"]
    assert "EXT_meshopt_compression" in assembly.gltf["extensionsRequired"]


def test_compression_shrinks_the_file(assembly, uncompressed):
    """`-cc` is doing its job, measured against the same scene uncompressed.

    meshopt plus quantization should roughly halve a mesh this simple. A ratio
    near 1 would mean a flag was dropped somewhere — the file would still load,
    and nobody would notice until a 200 MB assembly arrived as a 400 MB GLB.
    """
    assert len(assembly.glb_bytes) < uncompressed.size * 0.9, (
        f"compressed {len(assembly.glb_bytes)} vs uncompressed {uncompressed.size}"
    )


def test_the_scene_is_named_after_the_file(assembly, brep):
    # cadResultToGroup names its root group after the file when the reader's root
    # node has no name — which for every reader here it does not. GLTFLoader gives
    # gltf.scene the glTF scene's name, so this is the same string the browser
    # path would have shown.
    assert assembly.gltf["scenes"][0]["name"] == "assembly"
    assert brep.gltf["scenes"][0]["name"] == "box"


# ─── The tree ───────────────────────────────────────────────────────────────


def test_the_assembly_tree_survives_conversion_and_compression(assembly):
    assert effective_tree(assembly.gltf) == EXPECTED_TREE


def test_part_names_come_out_in_reader_order(assembly):
    assert part_names(assembly.gltf) == [
        "Base Plate",
        "Corner Bracket",
        "M6 Bolt",
        "M6 Bolt",
        "Corner Bracket",
        "M6 Bolt",
        "M6 Bolt",
        "M6 Bolt",
        "M6 Bolt",
    ]


def test_gltfpack_kept_the_tree(assembly, uncompressed):
    """The compressed file has the same tree as the one this service wrote.

    gltfpack merges and prunes nodes by default; `-kn` is what stops it, and this
    is the test that would fail if that flag were ever dropped. Comparing against
    the uncompressed output separates "the converter wrote the wrong tree" (which
    test_the_assembly_tree_survives_conversion_and_compression catches) from
    "gltfpack changed it".
    """
    assert effective_tree(uncompressed.gltf) == EXPECTED_TREE
    assert effective_tree(assembly.gltf) == EXPECTED_TREE
    assert part_names(uncompressed.gltf) == part_names(assembly.gltf)
    assert mesh_usage(uncompressed.gltf) == mesh_usage(assembly.gltf)


def test_gltfpack_kept_the_names(assembly):
    """`-kn` is not a size optimisation; without it parts merge and identity moves.

    Asserted on the compressed file specifically, because that is the file the api
    stores and every participant loads: a name that only survives the
    uncompressed draft is a name that does not survive.
    """
    names = {node.get("name") for node in assembly.gltf["nodes"]}

    assert {"Frame Assembly", "Base Plate", "Corner Joint", "Corner Bracket", "M6 Bolt"} <= names


def test_the_reported_part_count_is_the_number_of_pickable_parts(assembly):
    assert assembly.part_count == 9
    assert len(part_names(assembly.gltf)) == assembly.part_count
    assert assembly.triangle_count > 0
    assert assembly.convert_ms > 0


# ─── Instancing ─────────────────────────────────────────────────────────────


def test_repeated_parts_share_one_mesh(assembly):
    """Nine parts, three meshes: XDE says instances, the GLB says one mesh each.

    This is the requirement the later tasks build on. Tessellating every instance
    separately would produce nine meshes and nine copies of the bolt's triangles;
    a 5 000-fastener assembly would not fit in the budget that makes server-side
    conversion worth having.
    """
    usage = mesh_usage(assembly.gltf)

    assert assembly.unique_meshes == 3
    assert len(assembly.gltf["meshes"]) == 3
    # One plate, two brackets, six bolts — and the six bolts are ONE mesh.
    assert sorted(usage.values()) == [1, 2, 6]
    assert max(usage.values()) == 6


def test_instances_differ_by_their_matrix_not_their_geometry(assembly):
    """Six bolts: one mesh, six placements, one size.

    The other half of the instancing requirement. Sharing a mesh index is only
    useful if the instances are still where the assembly put them, and it is only
    correct if they are all the same part — so this checks the world position of
    each of the six (all different) and their extents (all identical).
    """
    bolts = [
        (low, high)
        for name, low, high in part_bounds(assembly.gltf)
        if name == "M6 Bolt"
    ]

    assert len(bolts) == 6

    centres = {
        tuple(round((low[axis] + high[axis]) / 2, 3) for axis in range(3))
        for low, high in bolts
    }
    assert len(centres) == 6, f"the bolts are not in six places: {sorted(centres)}"

    # Sorted per part: the joint that is turned 90° has its bolt axes swapped, so
    # the bounding BOX differs by a permutation while the part is identical.
    sizes = {
        tuple(sorted(round(high[axis] - low[axis], 2) for axis in range(3)))
        for low, high in bolts
    }
    assert len(sizes) == 1, f"the bolts are not all the same part: {sorted(sizes)}"
    (thin, also_thin, tall) = sizes.pop()
    # r3 × 20 mm. The diameter reads slightly under 6 because a tessellated
    # cylinder is a polygon INSCRIBED in the circle — it can never read over.
    assert tall == pytest.approx(20.0, abs=0.05)
    assert thin == pytest.approx(also_thin, abs=0.05)
    assert 5.9 <= thin < 6.0


# ─── Orientation and units ──────────────────────────────────────────────────


def test_the_output_is_y_up(assembly):
    """A Z-up STEP becomes a Y-up GLB, so the client must not rotate it again.

    The fixture spans x 0…120, y 0…80, z −20…48 in millimetres. Z_UP_TO_Y_UP in
    utils/modelLoader.ts is a −90° rotation about +X, which maps (x, y, z) to
    (x, z, −y) — so the 80 mm that was along Y becomes 80 mm along −Z, and the
    68 mm that was along Z becomes 68 mm along +Y. Getting this wrong is not
    subtle: the whole assembly lies on its side.
    """
    (low_x, low_y, low_z), (high_x, high_y, high_z) = world_bounds(assembly.gltf)
    (z_low_x, z_low_y, z_low_z), (z_high_x, z_high_y, z_high_z) = ASSEMBLY_Z_UP_BOUNDS

    # The tolerance is gltfpack's quantization step, not sloppiness: KHR_mesh_-
    # quantization stores positions as 14-bit integers over the scene bounds, so
    # a 120 mm assembly lands on a grid of about 0.0075 mm. Asserting exact
    # equality here would be asserting something the format does not promise.
    tolerance = 0.05

    assert low_x == pytest.approx(z_low_x, abs=tolerance)
    assert high_x == pytest.approx(z_high_x, abs=tolerance)
    assert low_y == pytest.approx(z_low_z, abs=tolerance)
    assert high_y == pytest.approx(z_high_z, abs=tolerance)
    assert low_z == pytest.approx(-z_high_y, abs=tolerance)
    assert high_z == pytest.approx(-z_low_y, abs=tolerance)


def test_units_are_the_files_own_millimetres_not_metres(assembly):
    """The browser path does not rescale, so this does not either.

    occt-import-js hands three.js the numbers the STEP file carries, and
    `centerModel` in utils/modelLoader.ts normalises whatever arrives
    (baseScale = 2 / maxDim). Rescaling here would put a converted model at a
    different size from the same file imported in a browser, which is a visible
    difference in a room where one participant has each.
    """
    (low_x, _, _), (high_x, _, _) = world_bounds(assembly.gltf)

    assert high_x - low_x == pytest.approx(120.0, abs=0.05)


# ─── Colour and material ────────────────────────────────────────────────────


def test_part_colours_reach_the_materials_as_linear_values(assembly):
    colours = material_colours(assembly.gltf)

    assert len(colours) == 3
    for srgb in (PLATE_SRGB, BRACKET_SRGB, BOLT_SRGB):
        expected = tuple(srgb_to_linear(channel) for channel in srgb) + (1.0,)
        assert any(
            all(actual == pytest.approx(want, abs=1e-4) for actual, want in zip(colour, expected))
            for colour in colours
        ), f"no material carries {srgb}"


def test_the_material_matches_what_the_browser_shows(assembly):
    """metalness 0.2, roughness 0.6, double-sided: cadToThree.ts's materialFor."""
    for material in assembly.gltf["materials"]:
        pbr = material["pbrMetallicRoughness"]
        assert pbr["metallicFactor"] == pytest.approx(0.2, abs=1e-5)
        assert pbr["roughnessFactor"] == pytest.approx(0.6, abs=1e-5)
        assert material["doubleSided"] is True


def test_an_uncoloured_file_gets_the_neutral_grey(brep):
    """0.7, 0.7, 0.75 sRGB — neutralColor() in utils/cadToThree.ts."""
    colours = material_colours(brep.gltf)

    assert len(colours) == 1
    expected = tuple(srgb_to_linear(channel) for channel in (0.7, 0.7, 0.75)) + (1.0,)
    assert colours[0] == pytest.approx(expected, abs=1e-4)


# ─── The other readers ──────────────────────────────────────────────────────


def test_a_brep_file_becomes_numbered_parts(brep):
    """importer-brep.cpp: one unnamed root, meshes named "Part 1", "Part 2", …"""
    assert effective_tree(brep.gltf) == ("Part 1", "PART", [])
    assert brep.part_count == 1
    # A box is twelve triangles and no more: a coarser or finer count would mean
    # the deflection constants drifted from the browser's.
    assert brep.triangle_count == 12


def test_the_brep_is_y_up_too(brep):
    # The fixture box is 30 × 20 × 10 at the origin, Z-up: after −90° about +X
    # the 10 mm that was Z is along Y and the 20 mm that was Y is along −Z.
    (low_x, low_y, low_z), (high_x, high_y, high_z) = world_bounds(brep.gltf)

    assert (low_x, high_x) == pytest.approx((0.0, 30.0), abs=0.05)
    assert (low_y, high_y) == pytest.approx((0.0, 10.0), abs=0.05)
    assert (low_z, high_z) == pytest.approx((-20.0, 0.0), abs=0.05)


def test_a_file_the_reader_cannot_parse_is_a_422_not_a_crash(tmp_path):
    broken = tmp_path / "broken.step"
    broken.write_bytes(b"ISO-10303-21;\nthis is not a STEP file, it is a sentence\n")

    runner = SubprocessRunner(load_settings({}))
    with pytest.raises(ConvertUnreadable) as failure:
        asyncio.run(runner.run(broken, file_name=broken.name, reader="step"))

    assert failure.value.status == 422
    assert failure.value.code == "convert_unreadable"
    # The caller's sentence is not in the message: errors.py keeps it content-free.
    assert "sentence" not in failure.value.message


def test_a_valid_step_that_is_not_a_step_is_refused(tmp_path):
    """A GLB renamed to .step: the reader refuses it, nothing guesses."""
    renamed = tmp_path / "model.step"
    renamed.write_bytes(b"glTF\x02\x00\x00\x00" + b"\x00" * 64)

    runner = SubprocessRunner(load_settings({}))
    with pytest.raises(ConvertUnreadable):
        asyncio.run(runner.run(renamed, file_name=renamed.name, reader="step"))


def test_conversions_are_deterministic(assembly):
    """Two runs of the same file give the same bytes.

    Worth pinning because the api (task 03b) stores a converted model under the
    SHA-256 of its SOURCE and expects one answer per file; a conversion that
    varied run to run would make two participants' imports of the same assembly
    disagree about more than the geometry.
    """
    again = _convert_once(ASSEMBLY_STEP, "step")

    assert again.glb_bytes == assembly.glb_bytes

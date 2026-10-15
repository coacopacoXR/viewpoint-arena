"""Parity with the browser CAD path this service replaces.

convert_service/cad.py is a second implementation of what utils/cadWorker.ts +
utils/cadToThree.ts do in the browser, and the two have to agree on the numbers
and the format list or a converted model looks different from an imported one.
Nothing at runtime keeps them in step, so these tests read the TypeScript SOURCE
and fail when it drifts — the same trick capture-service's
tests/test_typescript_parity.py uses for the InsightCard contract.

They need a full checkout of the repository. Inside the service image there is no
TypeScript to read (only convert-service/ is copied), so they skip with a reason
rather than failing; `npx tsx convert-service/scripts/parity.mjs` is the check
that runs where the app's source is, and it compares whole trees rather than
constants.

The tessellation numbers are read out of cad.py's source with `ast` instead of
being imported, because importing convert_service.cad imports OCP — and this
parity check is exactly the one a contributor without the engine installed should
still be able to run.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

from convert_service import formats

REPO_ROOT = Path(__file__).resolve().parents[2]
MODEL_FORMATS_TS = REPO_ROOT / "utils" / "modelFormats.ts"
CAD_IMPORT_TS = REPO_ROOT / "utils" / "cadImport.ts"
MODEL_LOADER_TS = REPO_ROOT / "utils" / "modelLoader.ts"
CAD_PY = Path(__file__).resolve().parents[1] / "convert_service" / "cad.py"

requires_app_source = pytest.mark.skipif(
    not MODEL_FORMATS_TS.is_file(),
    reason=(
        "the app's TypeScript source is not present (this run is inside the "
        "convert-service image, which ships only convert-service/)"
    ),
)


def read(path: Path) -> str:
    assert path.is_file(), f"{path} is missing — parity cannot be checked"
    return path.read_text(encoding="utf-8")


def cad_py_constant(name: str) -> float:
    """A numeric module constant from cad.py, without importing OCP."""
    tree = ast.parse(CAD_PY.read_text(encoding="utf-8"))
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        for target in node.targets:
            if isinstance(target, ast.Name) and target.id == name:
                value = ast.literal_eval(node.value)
                assert isinstance(value, float), f"{name} is not a float literal"
                return value
    raise AssertionError(f"cad.py no longer defines {name}")


@requires_app_source
def test_the_extension_list_is_the_browsers_list():
    source = read(MODEL_FORMATS_TS)
    match = re.search(r"CAD_EXTENSIONS\s*=\s*\[(.*?)\]", source, re.DOTALL)
    assert match, "CAD_EXTENSIONS moved or was renamed in utils/modelFormats.ts"
    listed = tuple(re.findall(r"'([^']+)'", match.group(1)))

    assert formats.CAD_EXTENSIONS == listed


@requires_app_source
def test_the_reader_per_extension_is_the_browsers_reader():
    source = read(CAD_IMPORT_TS)
    match = re.search(r"CAD_READER_BY_EXTENSION[^=]*=\s*\{(.*?)\}", source, re.DOTALL)
    assert match, "CAD_READER_BY_EXTENSION moved or was renamed in utils/cadImport.ts"
    pairs = dict(re.findall(r"'([^']+)'\s*:\s*'([^']+)'", match.group(1)))

    assert formats.READER_BY_EXTENSION == pairs
    # The 415 response lists CAD_EXTENSIONS, so a format the app would send here
    # but this service would refuse is a user-visible dead end.
    assert set(formats.READER_BY_EXTENSION) == set(formats.CAD_EXTENSIONS)


@requires_app_source
def test_the_reader_labels_match():
    source = read(CAD_IMPORT_TS)
    match = re.search(r"CAD_READER_LABEL[^=]*=\s*\{(.*?)\}", source, re.DOTALL)
    assert match, "CAD_READER_LABEL moved or was renamed in utils/cadImport.ts"
    pairs = dict(re.findall(r"(\w+)\s*:\s*'([^']+)'", match.group(1)))

    assert formats.READER_LABEL == pairs


@requires_app_source
def test_the_tessellation_numbers_are_the_ones_the_worker_sends():
    """The single most load-bearing parity check in this service.

    A different deflection is a different mesh: different triangle counts,
    different silhouette on a curved part, and a converted model that does not
    match the one a reviewer remembers opening in the browser.
    """
    source = read(CAD_IMPORT_TS)
    match = re.search(r"CAD_TESSELLATION_PARAMS[^=]*=\s*\{(.*?)\}", source, re.DOTALL)
    assert match, "CAD_TESSELLATION_PARAMS moved or was renamed in utils/cadImport.ts"
    params = dict(re.findall(r"(\w+)\s*:\s*'?([\w.]+)'?", match.group(1)))

    assert params["linearUnit"] == "millimeter"
    assert params["linearDeflectionType"] == "bounding_box_ratio"
    assert float(params["linearDeflection"]) == cad_py_constant("LINEAR_DEFLECTION_RATIO")
    assert float(params["angularDeflection"]) == cad_py_constant("ANGULAR_DEFLECTION")


@requires_app_source
def test_the_y_up_rotation_is_the_one_the_browser_applies():
    """Z_UP_TO_Y_UP in utils/modelLoader.ts: −90° about +X.

    The browser applies it to a CAD import because upAxisFor() says every CAD
    extension is Z-up, and it must NOT apply it to a GLB. This service therefore
    bakes it in, and cad.py's `_y_up_rotation` is the other half of that pair —
    a change here without a change there tips every converted model on its side.
    test_conversion.py checks the resulting bounding box.
    """
    source = read(MODEL_LOADER_TS)
    match = re.search(
        r"Z_UP_TO_Y_UP\s*=\s*new THREE\.Quaternion\(\)\.setFromAxisAngle\(\s*"
        r"new THREE\.Vector3\(([^)]*)\),\s*([^)]*)\)",
        source,
    )
    assert match, "Z_UP_TO_Y_UP moved or changed shape in utils/modelLoader.ts"
    axis = [float(part) for part in match.group(1).split(",")]
    angle = match.group(2).strip()

    assert axis == [1.0, 0.0, 0.0]
    assert angle == "-Math.PI / 2"

    cad_source = CAD_PY.read_text(encoding="utf-8")
    assert "gp_Dir(1.0, 0.0, 0.0)" in cad_source
    assert "-math.pi / 2" in cad_source


def test_extension_of_normalises_a_windows_path_and_gives_up_cleanly():
    assert formats.extension_of("bracket.step") == ".step"
    assert formats.extension_of("bracket.STEP") == ".step"
    assert formats.extension_of("C:\\models\\bracket.stp") == ".stp"
    assert formats.extension_of("archive.tar.gz") == ".gz"
    assert formats.extension_of("no-extension") == ""
    assert formats.extension_of("") == ""
    assert formats.extension_of(None) == ""


def test_reader_for_maps_every_supported_extension():
    assert formats.reader_for("a.step") == "step"
    assert formats.reader_for("a.stp") == "step"
    assert formats.reader_for("a.iges") == "iges"
    assert formats.reader_for("a.igs") == "iges"
    assert formats.reader_for("a.brep") == "brep"
    assert formats.reader_for("a.brp") == "brep"
    # A mesh format is the api's problem, not this service's: the browser reads
    # those itself, and sending one here is a 415.
    assert formats.reader_for("a.glb") is None
    assert formats.reader_for("a.stl") is None
    assert formats.reader_for(None) is None


def test_base_name_of_matches_model_loaders_basenameof():
    """`file.name.replace(/\\.[^/.]+$/, '')` in utils/modelLoader.ts."""
    assert formats.base_name_of("bracket.step") == "bracket"
    assert formats.base_name_of("frame.assy.v2.step") == "frame.assy.v2"
    assert formats.base_name_of("no-extension") == "no-extension"
    assert formats.base_name_of(".step") == ".step"
    assert formats.base_name_of("C:\\models\\bracket.step") == "bracket"
    assert formats.base_name_of("") == ""
    assert formats.base_name_of(None) == ""

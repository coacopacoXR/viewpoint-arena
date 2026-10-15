#!/usr/bin/env python3
"""Generate convert-service's committed test fixtures.

    cd convert-service
    python scripts/make_fixtures.py                 # writes tests/fixtures/*
    python scripts/make_fixtures.py --out /tmp/fx   # somewhere else

Run it inside the image — it needs OpenCascade, which is what writes the files:

    docker compose run --rm convert-service python scripts/make_fixtures.py

Why generated and not hand-written: the fixtures have to be real B-rep files
with a real XDE structure — named parts, per-part colours, and above all
INSTANCES, because "several nodes sharing one mesh" is the property the tests
exist to prove and a text editor cannot produce it. And a fixture that a
committed script reproduces is a fixture a reviewer can read: the assembly below
is 40 lines of geometry rather than 40 KB of STEP entities nobody diffs.

Why they are committed anyway (perf/fixtures/ is not): these are under 100 KB
between them, they are the input to `docker compose run --rm convert-service
pytest` — the acceptance check for this service — and a test suite that has to
build its own fixtures needs the engine installed before it can even fail with a
useful message.

Every dimension below is a round number in millimetres, on purpose: the tests
assert on the converted bounding box, and a fixture whose extents are
recognisable is one whose assertions a reviewer can check by eye.
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

from OCP.BRep import BRep_Builder
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
from OCP.BRepTools import BRepTools
from OCP.Quantity import Quantity_Color, Quantity_TOC_RGB
from OCP.STEPCAFControl import STEPCAFControl_Writer
from OCP.STEPControl import STEPControl_AsIs
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDF import TDF_Label
from OCP.TDataStd import TDataStd_Name
from OCP.TDocStd import TDocStd_Document
from OCP.TopLoc import TopLoc_Location
from OCP.TopoDS import TopoDS_Compound, TopoDS_Shape
from OCP.XCAFDoc import XCAFDoc_ColorSurf, XCAFDoc_DocumentTool
from OCP.gp import gp_Ax1, gp_Ax2, gp_Dir, gp_Pnt, gp_Trsf, gp_Vec

# ─── The assembly ───────────────────────────────────────────────────────────
#
#     Frame Assembly                     (root, two levels below it)
#     ├── Base Plate            120 × 80 × 8      red
#     ├── Corner Joint  (× 2, one of them rotated)
#     │   ├── Corner Bracket     12 × 40 × 40     green
#     │   ├── M6 Bolt            r3 × 20          blue
#     │   └── M6 Bolt
#     ├── M6 Bolt               (loose, × 2)
#     └── M6 Bolt
#
# Eight solids, THREE distinct shapes: the bolt appears six times and the joint
# twice, so a converter that tessellated every instance separately would write
# eight meshes where three are enough. That ratio is the assertion.
#
# Two levels of nesting (root → joint → bracket) is the minimum that exercises a
# non-leaf node, and the rotated second joint is there because a translation-only
# fixture would pass with a converter that ignored rotation entirely.

PLATE = (120.0, 80.0, 8.0)
BRACKET = (12.0, 40.0, 40.0)
BOLT_RADIUS = 3.0
BOLT_HEIGHT = 20.0

PLATE_COLOUR = (0.80, 0.10, 0.10)
BRACKET_COLOUR = (0.20, 0.70, 0.30)
BOLT_COLOUR = (0.15, 0.25, 0.85)


def box(size: tuple[float, float, float], at: tuple[float, float, float] = (0, 0, 0)) -> TopoDS_Shape:
    return BRepPrimAPI_MakeBox(gp_Pnt(*at), *size).Shape()


def bolt() -> TopoDS_Shape:
    """A cylinder standing on the origin, axis +Z — a fastener's minimum."""
    return BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), BOLT_RADIUS, BOLT_HEIGHT).Shape()


def moved(shape: TopoDS_Shape, x: float, y: float, z: float) -> TopoDS_Shape:
    trsf = gp_Trsf()
    trsf.SetTranslation(gp_Vec(x, y, z))
    return shape.Located(TopLoc_Location(trsf))


def turned(shape: TopoDS_Shape, degrees: float, x: float, y: float, z: float) -> TopoDS_Shape:
    """Rotate about +Z through the origin, then translate — a placed instance."""
    rotation = gp_Trsf()
    rotation.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), math.radians(degrees))
    translation = gp_Trsf()
    translation.SetTranslation(gp_Vec(x, y, z))
    return shape.Located(TopLoc_Location(translation.Multiplied(rotation)))


def compound(shapes: list[TopoDS_Shape]) -> TopoDS_Shape:
    result = TopoDS_Compound()
    builder = BRep_Builder()
    builder.MakeCompound(result)
    for shape in shapes:
        builder.Add(result, shape)
    return result


def corner_joint(bracket_shape: TopoDS_Shape, bolt_shape: TopoDS_Shape) -> TopoDS_Shape:
    """The repeated sub-assembly, in its own frame: bracket on the origin, two bolts.

    The parts are passed in rather than built here, and that is not tidiness:
    `shape_tool.Search` finds a label by the shape's IDENTITY, so the bracket in
    this compound has to be the very object the writer is later asked to name.
    """
    return compound(
        [
            bracket_shape,
            moved(bolt_shape, 24.0, 8.0, -BOLT_HEIGHT),
            moved(bolt_shape, 24.0, 28.0, -BOLT_HEIGHT),
        ]
    )


def frame_assembly(
    plate_shape: TopoDS_Shape, joint: TopoDS_Shape, bolt_shape: TopoDS_Shape
) -> TopoDS_Shape:
    """The root: a plate, a joint at each end (the far one turned 90°), two loose bolts."""
    return compound(
        [
            plate_shape,
            moved(joint, 4.0, 4.0, PLATE[2]),
            turned(joint, 90.0, 116.0, 4.0, PLATE[2]),
            moved(bolt_shape, 60.0, 20.0, -BOLT_HEIGHT),
            moved(bolt_shape, 60.0, 60.0, -BOLT_HEIGHT),
        ]
    )


def write_assembly(destination: Path) -> int:
    """Write the fixture STEP file and return its size in bytes."""
    plate_shape = box(PLATE)
    bracket_shape = box(BRACKET)
    bolt_shape = bolt()
    joint = corner_joint(bracket_shape, bolt_shape)
    frame = frame_assembly(plate_shape, joint, bolt_shape)

    document = TDocStd_Document(TCollection_ExtendedString("XmlOcaf"))
    shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(document.Main())
    color_tool = XCAFDoc_DocumentTool.ColorTool_s(document.Main())
    # Off, so the labels carry the names below and nothing else: XDE's automatic
    # naming would label a part "Solid1" and the test asserting on names would
    # pass for the wrong reason.
    shape_tool.SetAutoNaming_s(False)

    root = shape_tool.AddShape(frame, True, True)
    for shape, name, colour in (
        (plate_shape, "Base Plate", PLATE_COLOUR),
        (bracket_shape, "Corner Bracket", BRACKET_COLOUR),
        (bolt_shape, "M6 Bolt", BOLT_COLOUR),
        (joint, "Corner Joint", None),
    ):
        label = TDF_Label()
        if not shape_tool.Search(shape, label, True, True, True):
            raise SystemExit(f"make_fixtures: cannot find the label for {name!r}")
        TDataStd_Name.Set_s(label, TCollection_ExtendedString(name))
        if colour is not None:
            color_tool.SetColor(label, Quantity_Color(*colour, Quantity_TOC_RGB), XCAFDoc_ColorSurf)
    TDataStd_Name.Set_s(root, TCollection_ExtendedString("Frame Assembly"))

    writer = STEPCAFControl_Writer()
    writer.SetNameMode(True)
    writer.SetColorMode(True)
    if not writer.Transfer(document, STEPControl_AsIs):
        raise SystemExit("make_fixtures: the STEP transfer failed")
    writer.Write(str(destination))
    if not destination.is_file():
        raise SystemExit(f"make_fixtures: nothing was written to {destination}")
    return destination.stat().st_size


def write_brep(destination: Path) -> int:
    """A single unnamed box as a BREP file — the format with no assembly at all.

    importer-brep.cpp gives the browser one unnamed root node whose meshes are
    "Part 1", "Part 2", …; this fixture is what pins that behaviour here.
    """
    shape = box((30.0, 20.0, 10.0))
    if not BRepTools.Write_s(shape, str(destination)):
        raise SystemExit(f"make_fixtures: could not write {destination}")
    return destination.stat().st_size


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--out",
        default=str(Path(__file__).resolve().parent.parent / "tests" / "fixtures"),
        help="directory to write the fixtures into (default: tests/fixtures)",
    )
    arguments = parser.parse_args(argv)

    destination = Path(arguments.out)
    destination.mkdir(parents=True, exist_ok=True)

    total = 0
    for name, writer in (("assembly.step", write_assembly), ("box.brep", write_brep)):
        size = writer(destination / name)
        total += size
        print(f"{name}: {size} bytes")

    print(f"total: {total} bytes")
    if total > 1024 * 1024:
        # The budget is in the task this script was written for: the fixtures are
        # committed, and a megabyte of B-rep is a megabyte every clone downloads.
        print("make_fixtures: the fixtures exceed the 1 MB budget", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

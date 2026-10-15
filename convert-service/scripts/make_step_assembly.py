#!/usr/bin/env python3
"""Generate the large STEP assembly the perf benchmark imports.

    cd convert-service
    docker compose run --rm convert-service python scripts/make_step_assembly.py --parts 3200
    docker compose run --rm convert-service python scripts/make_step_assembly.py \\
        --parts 800 --seed 7 --out /tmp/small.step

Written to `<repo>/perf/fixtures/step-assembly-<parts>.step` by default, next to
the GLB that scripts/perf/make-assembly.mjs builds, and gitignored for the same
reason: a generated assembly is tens of megabytes of B-rep entities that nobody
can diff, and a benchmark that needs a committed 40 MB fixture is a benchmark
nobody runs.

WHY THIS IS A SEPARATE GENERATOR from make-assembly.mjs, which already builds an
assembly of N parts: that one writes a GLB, so it measures the app's render path.
This one writes a STEP file, so it measures the path the app actually takes for a
CAD import — tessellation included — and it is the only way to compare the two
implementations of that tessellation on IDENTICAL geometry:

    browser:  STEP → occt-import-js (WASM)  → cadResultToGroup → three
    server:   STEP → convert-service (OCP)  → GLB → GLTFLoader   → three

Same input file, same deflection, so a difference in the numbers is a difference
in the two kernels or in the two output formats, not in the fixture.

The shape of the assembly follows make-assembly.mjs on purpose — roughly 70%
repeats of a small fastener set, 30% one-off parts, nested three levels — because
the cost that matters is per PART, not per triangle, and a grid of cubes would
measure the wrong thing. It is also what makes this a fair test of the instancing
requirement: repeated parts are added as the SAME TopoDS_Shape, so XDE stores one
master and N references, and a converter that tessellated each instance would
produce N meshes where one is enough.

Seeded and dimensioned from that seed, so two runs on two machines produce the
same file and a frame time from this week is comparable with one from next.
"""

from __future__ import annotations

import argparse
import math
import random
import sys
import time
from pathlib import Path

from OCP.BRep import BRep_Builder
from OCP.BRepPrimAPI import (
    BRepPrimAPI_MakeBox,
    BRepPrimAPI_MakeCone,
    BRepPrimAPI_MakeCylinder,
    BRepPrimAPI_MakeSphere,
)
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

DEFAULT_PARTS = 800

#: The split make-assembly.mjs uses, so the two generators describe the same
#: kind of machine.
REPEAT_FRACTION = 0.7

#: How many distinct fastener shapes the repeats are drawn from. Small, because
#: that is the point: a real assembly has a handful of fastener part numbers and
#: thousands of instances of them.
FASTENER_KINDS = 12

SUBASSEMBLY_PARTS = (6, 14)
MODULES_PER_ROOT = 8

PALETTE = (
    (0.55, 0.57, 0.60),  # bare steel
    (0.20, 0.22, 0.25),  # blackened
    (0.85, 0.55, 0.10),  # zinc/brass
    (0.15, 0.35, 0.65),  # anodised blue
    (0.60, 0.15, 0.15),  # primer red
    (0.20, 0.55, 0.30),  # primer green
)


def place(shape: TopoDS_Shape, trsf: gp_Trsf) -> TopoDS_Shape:
    return shape.Located(TopLoc_Location(trsf))


def translation(x: float, y: float, z: float) -> gp_Trsf:
    trsf = gp_Trsf()
    trsf.SetTranslation(gp_Vec(x, y, z))
    return trsf


def rotation_z(degrees: float) -> gp_Trsf:
    trsf = gp_Trsf()
    trsf.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), math.radians(degrees))
    return trsf


def placed(x: float, y: float, z: float, degrees: float = 0.0) -> gp_Trsf:
    """Rotate about +Z, then translate — the order a CAD placement uses."""
    return translation(x, y, z).Multiplied(rotation_z(degrees))


def compound(shapes: list[TopoDS_Shape]) -> TopoDS_Shape:
    result = TopoDS_Compound()
    builder = BRep_Builder()
    builder.MakeCompound(result)
    for shape in shapes:
        builder.Add(result, shape)
    return result


# ─── Part shapes ────────────────────────────────────────────────────────────
#
# Primitives, not booleans: a fused or cut solid costs an order of magnitude more
# to build than a box, and the benchmark is about how many PARTS a converter can
# place and tessellate, not about how complex each one is. Sizes vary with the
# seed so the tessellation is not identical from part to part.


def fastener(rng: random.Random, kind: int) -> TopoDS_Shape:
    """One of the handful of shapes the repeated parts are instances of."""
    scale = 0.6 + rng.random() * 1.4
    if kind % 4 == 0:
        return BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), 3.0 * scale, 18.0 * scale).Shape()
    if kind % 4 == 1:
        return BRepPrimAPI_MakeCone(
            gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), 6.0 * scale, 3.0 * scale, 10.0 * scale
        ).Shape()
    if kind % 4 == 2:
        return BRepPrimAPI_MakeSphere(gp_Pnt(0, 0, 0), 5.0 * scale).Shape()
    return BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 0), 12.0 * scale, 12.0 * scale, 4.0 * scale).Shape()


def one_off(rng: random.Random) -> TopoDS_Shape:
    """A unique part: a plate, a block or a cylinder nobody else in the file has."""
    pick = rng.random()
    if pick < 0.4:
        return BRepPrimAPI_MakeBox(
            gp_Pnt(0, 0, 0),
            rng.uniform(40, 220),
            rng.uniform(30, 160),
            rng.uniform(3, 18),
        ).Shape()
    if pick < 0.75:
        return BRepPrimAPI_MakeBox(
            gp_Pnt(0, 0, 0),
            rng.uniform(15, 60),
            rng.uniform(15, 60),
            rng.uniform(15, 90),
        ).Shape()
    return BRepPrimAPI_MakeCylinder(
        gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), rng.uniform(8, 30), rng.uniform(20, 120)
    ).Shape()


def build(parts: int, seed: int) -> tuple[TopoDS_Shape, list[tuple[TopoDS_Shape, str, tuple]]]:
    """The root compound, plus a (shape, name, colour) entry for every part in it.

    The list holds the shape OBJECTS, not keys derived from them: the same object
    appearing twice in a compound is what makes XDE store one master and N
    instances, and `write` has to hand that very object to `Search` to find the
    label XDE made for it. Two equal-looking but distinct objects become two
    masters, which is exactly the difference between a repeated fastener and a
    one-off part.
    """
    rng = random.Random(seed)
    entries: list[tuple[TopoDS_Shape, str, tuple]] = []

    fasteners = []
    for kind in range(FASTENER_KINDS):
        shape = fastener(rng, kind)
        fasteners.append(shape)
        entries.append((shape, f"Fastener {kind + 1:02d}", PALETTE[kind % len(PALETTE)]))

    placed_parts = 0
    unique_index = 0
    modules = []
    spacing = 260.0

    for module_index in range(MODULES_PER_ROOT):
        subassemblies = []
        subassembly_index = 0
        while placed_parts < parts and subassembly_index < max(1, parts // (MODULES_PER_ROOT * 8)):
            members: list[TopoDS_Shape] = []
            for slot in range(rng.randint(*SUBASSEMBLY_PARTS)):
                if placed_parts >= parts:
                    break
                if rng.random() < REPEAT_FRACTION:
                    shape = rng.choice(fasteners)
                else:
                    shape = one_off(rng)
                    unique_index += 1
                    entries.append(
                        (shape, f"Part {unique_index:05d}", PALETTE[rng.randrange(len(PALETTE))])
                    )
                members.append(
                    place(
                        shape,
                        placed(
                            slot * 22.0 + rng.uniform(-4, 4),
                            rng.uniform(-40, 40),
                            rng.uniform(0, 30),
                            rng.uniform(0, 360),
                        ),
                    )
                )
                placed_parts += 1

            subassembly = compound(members)
            subassembly_index += 1
            entries.append(
                (
                    subassembly,
                    f"Module {module_index + 1} Sub {subassembly_index}",
                    PALETTE[(module_index + subassembly_index) % len(PALETTE)],
                )
            )
            subassemblies.append(
                place(
                    subassembly,
                    placed((subassembly_index % 4) * 90.0, (subassembly_index // 4) * 90.0, 0.0),
                )
            )

        module = compound(subassemblies)
        entries.append((module, f"Module {module_index + 1}", PALETTE[module_index % len(PALETTE)]))
        modules.append(
            place(module, placed((module_index % 4) * spacing, (module_index // 4) * spacing, 0.0))
        )

    root = compound(modules)
    entries.append((root, "Benchmark Assembly", (0.45, 0.45, 0.50)))
    return root, entries


def write(
    root: TopoDS_Shape,
    entries: list[tuple[TopoDS_Shape, str, tuple]],
    destination: Path,
) -> int:
    """Put the assembly into an XDE document, name and colour it, write the STEP."""
    document = TDocStd_Document(TCollection_ExtendedString("XmlOcaf"))
    shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(document.Main())
    color_tool = XCAFDoc_DocumentTool.ColorTool_s(document.Main())
    # Off: automatic naming would label every part "Solid4711" and the benchmark
    # would be measuring a file whose model tree is useless.
    shape_tool.SetAutoNaming_s(False)

    shape_tool.AddShape(root, True, True)

    named = 0
    for shape, name, colour in entries:
        found = TDF_Label()
        # A shape XDE folded into its parent rather than gave its own label is
        # simply not found, and keeps no name. That is normal — a real export
        # looks like this too — so it is counted and reported, not treated as a
        # failure.
        if not shape_tool.Search(shape, found, True, True, True):
            continue
        TDataStd_Name.Set_s(found, TCollection_ExtendedString(name))
        color_tool.SetColor(found, Quantity_Color(*colour, Quantity_TOC_RGB), XCAFDoc_ColorSurf)
        named += 1
    print(f"named {named} of {len(entries)} shapes", file=sys.stderr)

    writer = STEPCAFControl_Writer()
    writer.SetNameMode(True)
    writer.SetColorMode(True)
    if not writer.Transfer(document, STEPControl_AsIs):
        raise SystemExit("make_step_assembly: the STEP transfer failed")
    writer.Write(str(destination))
    if not destination.is_file():
        raise SystemExit(f"make_step_assembly: nothing was written to {destination}")
    return destination.stat().st_size


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--parts", type=int, default=DEFAULT_PARTS, help=f"parts to place (default {DEFAULT_PARTS})")
    parser.add_argument("--seed", type=int, default=11, help="the seed everything is derived from (default 11)")
    parser.add_argument(
        "--out",
        default=None,
        help="where to write it (default <repo>/perf/fixtures/step-assembly-<parts>.step)",
    )
    arguments = parser.parse_args(argv)

    if arguments.parts < 1:
        raise SystemExit("make_step_assembly: --parts must be at least 1")

    if arguments.out:
        destination = Path(arguments.out).resolve()
    else:
        repository = Path(__file__).resolve().parents[2]
        destination = repository / "perf" / "fixtures" / f"step-assembly-{arguments.parts}.step"
    destination.parent.mkdir(parents=True, exist_ok=True)

    started = time.perf_counter()
    root, entries = build(arguments.parts, arguments.seed)
    built = time.perf_counter() - started

    started = time.perf_counter()
    size = write(root, entries, destination)
    written = time.perf_counter() - started

    print(f"{destination}")
    print(f"  parts requested {arguments.parts}, shapes {len(entries)}, seed {arguments.seed}")
    print(f"  built in {built:.1f}s, wrote {size / (1024 * 1024):.1f} MB in {written:.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

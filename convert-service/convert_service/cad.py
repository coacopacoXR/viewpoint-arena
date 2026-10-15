"""Read STEP/IGES/BREP with native OpenCascade and tessellate it.

This module is the server half of what `utils/cadWorker.ts` does in the browser,
and its one job is to produce the SAME assembly tree that
`cadResultToGroup` (utils/cadToThree.ts) builds from occt-import-js today. That
is not a stylistic preference: per-part identity in this app — the model tree,
selection, highlight, pins, visibility and moving parts in variants — is derived
from the tree a client walks after an import, keyed on `userData.nodeId` and
`userData.meshIndex`. A server conversion that produced a flatter or differently
named tree would move every pin in every review that used to be a STEP file.

occt-import-js IS OpenCascade compiled to WebAssembly, and its reader is
available in this repo at
node_modules/occt-import-js/occt-import-js/src/importer-xcaf.cpp. The walk below
is a transcription of that file, rule for rule:

    importer-xcaf.cpp                       here
    ─────────────────────────────────────── ──────────────────────────────
    XcafRootNode::GetChildren               _Converter._xde_roots
    IsFreeShape                             _is_free_shape
    TriangulateShape (importer-utils.cpp)   _tessellate
    XcafNode::IsMeshNode                    _is_mesh_node
    XcafNode::EnumerateShapeMeshes          _mesh_sources
    XcafShapeMesh::GetName / GetShapeName   _shape_name
    XcafFace::GetColor / GetLabelColor      _label_colour, _shape_colour
    GetLabelName (follows references)       _label_name
    OcctFace::EnumerateVertices/Normals/    _tessellate_faces
        Triangles (importer-utils.cpp)
    js-interface.cpp HierarchyWriter        gltf.write_glb

Where a difference was unavoidable it is recorded in convert-service/README.md
§3 "Parity with the browser path". The two that matter most, both forced by
glTF rather than chosen here: a node in glTF carries at most one mesh, so the N
meshes occt hangs off one node become N child nodes (which is what
GLTFLoader turns back into N THREE.Mesh siblings — the same tree cadResultToGroup
builds); and coordinates stay in the file's own units, because that is what the
browser path does and `centerModel` in utils/modelLoader.ts normalises.

Nothing in this module is imported by the HTTP service. OCP is a 67 MB native
module that can segfault on a malformed file, so the conversion runs in a
subprocess (convert_service/worker.py) and only that process pays for it.
"""

from __future__ import annotations

import math
from array import array
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from . import formats
from .errors import ConvertEmpty, ConvertUnreadable, EngineUnavailable
from .gltf import Colour, MeshGeometry, Primitive, SceneNode, multiply_matrices

try:
    from OCP.BRep import BRep_Builder, BRep_Tool
    from OCP.BRepBndLib import BRepBndLib
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.BRepTools import BRepTools
    from OCP.Bnd import Bnd_Box
    from OCP.IGESCAFControl import IGESCAFControl_Reader
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.Precision import Precision
    from OCP.Quantity import Quantity_Color
    from OCP.STEPCAFControl import STEPCAFControl_Reader
    from OCP.TCollection import TCollection_AsciiString, TCollection_ExtendedString
    from OCP.TDF import TDF_ChildIterator, TDF_Label, TDF_Tool
    from OCP.TDataStd import TDataStd_Name
    from OCP.TDocStd import TDocStd_Document
    from OCP.TopAbs import (
        TopAbs_FACE,
        TopAbs_REVERSED,
        TopAbs_SHELL,
        TopAbs_SOLID,
    )
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopLoc import TopLoc_Location
    from OCP.TopoDS import TopoDS, TopoDS_Shape
    from OCP.UnitsMethods import UnitsMethods, UnitsMethods_LengthUnit_Millimeter
    from OCP.XCAFDoc import (
        XCAFDoc_ColorCurv,
        XCAFDoc_ColorGen,
        XCAFDoc_ColorSurf,
        XCAFDoc_DocumentTool,
        XCAFDoc_ShapeTool,
    )
    from OCP.collections import Sequence_TDF_Label
    from OCP.gp import gp_Ax1, gp_Dir, gp_Pnt, gp_Trsf
except ImportError as exc:  # pragma: no cover - depends on what is installed
    # Raised as the service's own error type so the worker can turn it into the
    # `engine_unavailable` code instead of a traceback nobody can act on.
    raise EngineUnavailable(f"OpenCascade (OCP) is not importable: {exc}") from exc


# ─── Tessellation ───────────────────────────────────────────────────────────
#
# These three numbers ARE CAD_TESSELLATION_PARAMS in utils/cadImport.ts:
#
#     linearUnit: 'millimeter'
#     linearDeflectionType: 'bounding_box_ratio'
#     linearDeflection: 0.001
#     angularDeflection: 0.5
#
# and they are the same numbers occt-import-js defaults to (ImportParams in
# importer.cpp). Keeping them identical is what makes a converted GLB
# indistinguishable in smoothness from a browser-tessellated one, and what makes
# the triangle counts comparable when the perf benchmark (task 02) compares the
# two paths. tests/test_conversion.py pins them against the TypeScript source.

#: `linearDeflection` with `linearDeflectionType: 'bounding_box_ratio'`: the
#: chord tolerance is this fraction of the shape's average bounding-box extent.
LINEAR_DEFLECTION_RATIO = 0.001

#: `angularDeflection`, in RADIANS — the value is passed straight to
#: BRepMesh_IncrementalMesh by both this module and importer-utils.cpp.
ANGULAR_DEFLECTION = 0.5

#: What importer-utils.cpp falls back to when the ratio produces a deflection
#: smaller than OpenCascade's own confusion tolerance: 1 mm in the file's unit.
FALLBACK_DEFLECTION_MM = 1.0

#: The linear unit the browser path asks for. The document unit is set to it the
#: same way ImporterXcaf::LoadFile does, so a STEP file written in inches is
#: scaled to millimetres by the reader here exactly as it is in the browser.
LINEAR_UNIT = UnitsMethods_LengthUnit_Millimeter


# ─── Orientation ────────────────────────────────────────────────────────────
#
# CAD kernels are Z-up, three.js is Y-up. The browser applies
# Z_UP_TO_Y_UP — a −90° rotation about X — to the imported group in
# parseModelFile (utils/modelLoader.ts), because upAxisFor('.step') is 'z'.
# A GLB is expected to arrive already Y-up (that is what
# UP_AXIS_BY_EXTENSION says of every mesh format), so the rotation is baked into
# the root nodes here and the client must NOT apply it again.

def _y_up_rotation() -> gp_Trsf:
    trsf = gp_Trsf()
    trsf.SetRotation(gp_Ax1(gp_Pnt(0.0, 0.0, 0.0), gp_Dir(1.0, 0.0, 0.0)), -math.pi / 2)
    return trsf


Y_UP_TRSF = _y_up_rotation()

IDENTITY_LOCATION = TopLoc_Location()

#: The mesh-cache owner for a BREP file, which has no labels to own anything.
BREP_OWNER_KEY = "brep"


def _matrix(trsf: gp_Trsf) -> tuple[float, ...]:
    """A gp_Trsf as a glTF node matrix: 16 floats, COLUMN-major.

    glTF stores matrices column-first, and `gp_Trsf.Value(row, column)` is
    1-based row-major, which is why the indices below look transposed.
    """
    translation = trsf.TranslationPart()
    return (
        trsf.Value(1, 1), trsf.Value(2, 1), trsf.Value(3, 1), 0.0,
        trsf.Value(1, 2), trsf.Value(2, 2), trsf.Value(3, 2), 0.0,
        trsf.Value(1, 3), trsf.Value(2, 3), trsf.Value(3, 3), 0.0,
        translation.X(), translation.Y(), translation.Z(), 1.0,
    )


def _matrix_of_location(location: TopLoc_Location) -> tuple[float, ...] | None:
    """A location as a glTF matrix, or None when it is the identity.

    Omitting the identity is not only smaller: a node with no matrix is a node a
    client can walk without multiplying anything, and every matrix written here
    is one it otherwise has to carry down the tree.
    """
    if location.IsIdentity():
        return None
    return _matrix(location.Transformation())


@dataclass(frozen=True)
class Conversion:
    """The result of one conversion, ready for gltf.write_glb."""

    roots: list[SceneNode]
    scene_name: str
    part_count: int
    triangle_count: int
    unique_meshes: int
    reader: str


def convert(source: Path, *, reader: str, file_name: str = "") -> Conversion:
    """Read and tessellate one CAD file.

    @param source Path to the uploaded file. The extension is NOT consulted —
           `reader` says which OpenCascade reader to use, and main.py has already
           rejected anything this service does not handle.
    @param file_name The client's X-File-Name, used only for the scene's name.
    @raises ConvertUnreadable if the reader refused the file or it holds no shape.
    @raises ConvertEmpty if it read fine but produced no tessellatable geometry.
    """
    return _Converter(file_name).run(source, reader)


# ─── Reading ────────────────────────────────────────────────────────────────


def _new_document() -> TDocStd_Document:
    """An empty XDE document, with the length unit the browser path asks for.

    Mirrors ImporterXcaf::LoadFile, including the storage-format argument: an
    XDE document has to name one. "XmlOcaf" is the format OCCT 8 registers for
    XDE documents; occt-import-js says "XmlXCAF", which the older kernel it is
    built against accepted. The value never reaches the output — the document is
    only ever read, never saved — so the difference cannot affect a conversion.
    """
    document = TDocStd_Document(TCollection_ExtendedString("XmlOcaf"))
    XCAFDoc_DocumentTool.SetLengthUnit_s(document, 1.0, LINEAR_UNIT)
    return document


def _read_xde(source: Path, reader: str) -> TDocStd_Document:
    """Read a STEP or IGES file into an XDE document: names, colours, instances.

    Both CAF readers are used with colour and name modes on, exactly as
    importer-step.cpp and importer-iges.cpp do. Without them a STEP file arrives
    as one grey fused solid — which is precisely what this service must not
    produce, because the assembly structure is the product.
    """
    document = _new_document()

    if reader == formats.READER_STEP:
        caf_reader = STEPCAFControl_Reader()
    elif reader == formats.READER_IGES:
        caf_reader = IGESCAFControl_Reader()
    else:
        raise ConvertUnreadable(f"no reader for {reader!r}")

    caf_reader.SetColorMode(True)
    caf_reader.SetNameMode(True)

    label = formats.READER_LABEL[reader]
    # ReadFile, not ReadStream: OCCT picks the reader from the file's content and
    # its extension, so the spooled upload keeps the original suffix (main.py) and
    # a .stp renamed to .step still reads.
    status = caf_reader.ReadFile(str(source))
    if status != IFSelect_RetDone:
        raise ConvertUnreadable(f"{label} reader refused the file (status {status})")
    if not caf_reader.Transfer(document):
        raise ConvertUnreadable(f"{label} transfer into the XDE document failed")
    return document


def _read_brep(source: Path) -> TopoDS_Shape:
    """Read a BREP file: one shape, no assembly, no names and no colours.

    That is what the format holds, and it is what importer-brep.cpp gives the
    browser: a single unnamed root node whose meshes are "Part 1", "Part 2", …
    """
    shape = TopoDS_Shape()
    builder = BRep_Builder()
    if not BRepTools.Read_s(shape, str(source), builder):
        raise ConvertUnreadable("BREP reader refused the file")
    if shape.IsNull():
        raise ConvertUnreadable("BREP file contains no shape")
    return shape


def _tessellate(shape: TopoDS_Shape) -> bool:
    """Mesh every face of `shape`, at the deflection the browser uses.

    False when the shape has no bounding box at all, which is what makes
    XcafRootNode::GetChildren skip a free shape rather than emit an empty node.
    Transcribed from TriangulateShape in importer-utils.cpp, including the
    `isRelative = false` argument and the 1 mm floor.
    """
    box = Bnd_Box()
    BRepBndLib.Add_s(shape, box, False)
    if box.IsVoid():
        return False

    low = box.CornerMin().Coord()
    high = box.CornerMax().Coord()
    average = sum(h - l for l, h in zip(low, high)) / 3.0
    deflection = average * LINEAR_DEFLECTION_RATIO
    if deflection < Precision.Confusion_s():
        deflection = FALLBACK_DEFLECTION_MM * UnitsMethods.GetLengthUnitScale_s(
            UnitsMethods_LengthUnit_Millimeter, LINEAR_UNIT
        )

    # The last two arguments are the OCCT defaults occt-import-js leaves alone:
    # not relative, not in parallel. Parallel meshing would use every core of the
    # container for one job while CONVERT_CONCURRENCY assumes one job at a time.
    BRepMesh_IncrementalMesh(shape, deflection, False, ANGULAR_DEFLECTION, False)
    return True


def _explore(shape: TopoDS_Shape, kind, avoid=None) -> list:
    """Every subshape of `shape` with topology type `kind`.

    TopExp_Explorer composes each subshape's Location with the ones above it, so
    a face comes back positioned in `shape`'s own frame — which is why
    _tessellate_faces can read a triangulation node and be done with it.
    """
    explorer = (
        TopExp_Explorer(shape, kind) if avoid is None else TopExp_Explorer(shape, kind, avoid)
    )
    found = []
    while explorer.More():
        found.append(explorer.Current())
        explorer.Next()
    return found


@dataclass
class _MeshSource:
    """One mesh of a mesh node, as XcafNode::EnumerateShapeMeshes enumerates them.

    `loose_faces` is the third case in that function: faces belonging to no
    shell, gathered into ONE unnamed mesh. It carries the parent shape rather
    than the faces themselves, because the explorer needs the shell to avoid.
    """

    shape: TopoDS_Shape
    loose_faces: bool = False


def _mesh_sources(shape: TopoDS_Shape) -> list[_MeshSource]:
    """Solids, then shells that are not part of a solid, then loose faces.

    The order is occt's, and it is visible: it decides the order of the meshes
    under a node, and therefore the "Part N" numbers an unnamed BREP solid gets.
    """
    sources = [_MeshSource(solid) for solid in _explore(shape, TopAbs_SOLID)]
    sources += [
        _MeshSource(shell) for shell in _explore(shape, TopAbs_SHELL, TopAbs_SOLID)
    ]
    if _explore(shape, TopAbs_FACE, TopAbs_SHELL):
        sources.append(_MeshSource(shape, loose_faces=True))
    return sources


# ─── Geometry ───────────────────────────────────────────────────────────────


@dataclass
class _FaceSpan:
    """One B-rep face's slice of a mesh's index buffer, with its colour.

    The equivalent of one entry in occt-import-js's `brep_faces`, which
    cadToThree.ts turns into a geometry group.
    """

    colour: Colour | None
    first_triangle: int
    last_triangle: int


def _tessellate_faces(
    shape: TopoDS_Shape,
    *,
    loose_faces: bool,
    face_colour: Callable[[TopoDS_Shape], Colour | None] | None = None,
) -> tuple[array, array, array, list[_FaceSpan]]:
    """Every triangle of `shape`, plus the per-face colour spans.

    Transcribed from OcctFace in importer-utils.cpp: vertices and normals are
    transformed by the face's Location, a REVERSED face flips its winding and
    negates its normals, and indices are 0-based into this mesh's own vertex
    buffer. The vertex list is NOT shared between faces — occt does not merge
    coincident vertices either, which is why a converted part has the same vertex
    count as a browser-tessellated one, and why gltfpack's meshopt compression
    (which does weld them) saves so much.

    `face_colour` resolves a face to its XDE colour. In practice it almost always
    returns None: a face inside a solid has no label of its own, so
    XCAFDoc_ShapeTool::Search finds nothing. That is true of the browser path too
    (XcafFace::GetColor goes through the same Search), and it is why a part of
    many faces still comes out as one material — see _primitives.
    """
    positions = array("f")
    normals = array("f")
    indices = array("I")
    spans: list[_FaceSpan] = []

    faces = _explore(shape, TopAbs_FACE, TopAbs_SHELL if loose_faces else None)
    for face_shape in faces:
        face = TopoDS.Face(face_shape)
        location = TopLoc_Location()
        triangulation = BRep_Tool.Triangulation_s(face, location)
        if triangulation is None:
            continue
        node_count = triangulation.NbNodes()
        triangle_count = triangulation.NbTriangles()
        # HasTriangulation() in importer-utils.cpp: a face with no nodes or no
        # triangles contributes nothing, and must not shift the index base.
        if node_count == 0 or triangle_count == 0:
            continue

        if not triangulation.HasNormals():
            triangulation.ComputeNormals()
        has_normals = triangulation.HasNormals()
        transformation = location.Transformation()
        reversed_winding = face.Orientation() == TopAbs_REVERSED
        vertex_offset = len(positions) // 3

        for node in range(1, node_count + 1):
            point = triangulation.Node(node).Transformed(transformation)
            positions.append(point.X())
            positions.append(point.Y())
            positions.append(point.Z())
            if has_normals:
                normal = triangulation.Normal(node).Transformed(transformation)
                if reversed_winding:
                    normals.append(-normal.X())
                    normals.append(-normal.Y())
                    normals.append(-normal.Z())
                else:
                    normals.append(normal.X())
                    normals.append(normal.Y())
                    normals.append(normal.Z())

        first_triangle = len(indices) // 3
        for triangle_index in range(1, triangle_count + 1):
            triangle = triangulation.Triangle(triangle_index)
            a = triangle.Value(1) - 1
            b = triangle.Value(2) - 1
            c = triangle.Value(3) - 1
            if reversed_winding:
                indices.append(vertex_offset + a)
                indices.append(vertex_offset + c)
                indices.append(vertex_offset + b)
            else:
                indices.append(vertex_offset + a)
                indices.append(vertex_offset + b)
                indices.append(vertex_offset + c)

        spans.append(
            _FaceSpan(
                colour=face_colour(face_shape) if face_colour is not None else None,
                first_triangle=first_triangle,
                last_triangle=len(indices) // 3 - 1,
            )
        )

    # js-interface.cpp only attaches a NORMAL attribute when every vertex got
    # one, and cadToThree.ts computes vertex normals otherwise. Dropping the
    # partial buffer reproduces that: modelLoader.ts's applySceneDefaults
    # computes them on the client for a mesh that arrives without any.
    complete_normals = normals if len(normals) == len(positions) else array("f")
    return positions, complete_normals, indices, spans


def _primitives(
    spans: list[_FaceSpan], indices: array, mesh_colour: Colour | None
) -> list[Primitive]:
    """Group a mesh's triangles by colour, the way cadToThree.ts groups them.

    `materialsFor` in utils/cadToThree.ts splits a mesh into one material per
    distinct face colour ONLY when the faces really differ; a solid of one colour
    keeps a single material, which is the common case and the cheaper one to
    render. In glTF the equivalent of a THREE geometry group is a mesh primitive,
    so one colour is one primitive and the mesh stays a single node.

    The visible difference is order: three's groups follow face order, glTF
    primitives follow colour order. Each triangle ends up with the same material
    either way, and nothing in the app reads `geometry.groups`.
    """
    distinct = {span.colour.key for span in spans if span.colour is not None}

    if len(distinct) < 2:
        single = next((span.colour for span in spans if span.colour is not None), None)
        colour = mesh_colour or single or Colour.neutral()
        return [Primitive(colour=colour, indices=indices)]

    palette: dict[str, Colour] = {}
    buckets: dict[str, array] = {}
    for span in spans:
        key = span.colour.key if span.colour is not None else ""
        if key not in palette:
            # cadToThree's materialIndexFor: a face with no colour of its own
            # gets the mesh's colour.
            palette[key] = span.colour or mesh_colour or Colour.neutral()
            buckets[key] = array("I")
        buckets[key].extend(indices[span.first_triangle * 3 : (span.last_triangle + 1) * 3])

    return [Primitive(colour=palette[key], indices=buckets[key]) for key in palette]


# ─── The walk ───────────────────────────────────────────────────────────────


@dataclass
class _CachedMesh:
    """A tessellated mesh, kept so every instance of a part shares it.

    The placement is NOT part of the cache: instances differ exactly in where
    they sit, and the geometry is what is expensive.
    """

    geometry: MeshGeometry | None
    name: str


class _Converter:
    """One conversion. Holds the document's tools and the mesh cache."""

    def __init__(self, file_name: str) -> None:
        self.file_name = file_name
        self.shape_tool: XCAFDoc_ShapeTool | None = None
        self.color_tool = None
        # Keyed by (the label the geometry comes from, its index in that label's
        # enumeration). Two instances of one part hit the same key, which is what
        # makes them share one glTF mesh — see _owner_key.
        self.mesh_cache: dict[tuple[str, int], _CachedMesh] = {}
        # cadToThree's `nextPart`: a running count of meshes visited, used only
        # for the "Part N" name an unnamed mesh would otherwise not have.
        self.part_number = 0

    # ── entry point ────────────────────────────────────────────────────────

    def run(self, source: Path, reader: str) -> Conversion:
        if reader == formats.READER_BREP:
            shape = _read_brep(source)
            if not _tessellate(shape):
                raise ConvertEmpty("BREP file has no bounding box")
            roots = self._brep_roots(shape)
        else:
            roots = self._xde_roots(_read_xde(source, reader))

        if not roots:
            raise ConvertEmpty(f"{formats.READER_LABEL.get(reader, reader)} file produced no meshes")

        unique = len({id(cached.geometry) for cached in self.mesh_cache.values() if cached.geometry})
        return Conversion(
            roots=roots,
            # cadResultToGroup names the root group after the file when the CAD
            # root node carries no name — which, for every reader here, it does
            # not. GLTFLoader gives gltf.scene the glTF scene's name, so this is
            # the same string the browser path would have shown.
            scene_name=formats.base_name_of(self.file_name),
            part_count=sum(1 for _ in _iter_mesh_nodes(roots)),
            triangle_count=sum(
                node.mesh.triangle_count for node in _iter_mesh_nodes(roots) if node.mesh
            ),
            unique_meshes=unique,
            reader=reader,
        )

    def _xde_roots(self, document: TDocStd_Document) -> list[SceneNode]:
        """The free shapes at the top of the XDE tree, tessellated.

        XcafRootNode::GetChildren iterates the SHAPE TOOL's children and keeps
        the free shapes; ImporterXcaf::LoadFile separately refuses a document
        with no free shape at all. Both are reproduced, in that order, so a file
        occt-import-js would reject is a 422 here rather than an empty GLB.
        """
        main = document.Main()
        self.shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(main)
        self.color_tool = XCAFDoc_DocumentTool.ColorTool_s(main)

        free_shapes = Sequence_TDF_Label()
        self.shape_tool.GetFreeShapes(free_shapes)
        if len(free_shapes) == 0:
            raise ConvertUnreadable("the document contains no free shape")

        roots = []
        iterator = TDF_ChildIterator(self.shape_tool.Label())
        while iterator.More():
            label = iterator.Value()
            iterator.Next()
            if not self._is_free_shape(label):
                continue
            shape = self.shape_tool.GetShape_s(label)
            # TriangulateShape on the whole free shape, before the walk: one
            # deflection for the assembly, computed from its overall size, which
            # is why a small part in a big assembly is coarser than that part
            # opened on its own. Tessellation lives on the faces' TShapes, so
            # every instance of a part reuses it.
            if not _tessellate(shape):
                continue
            node = self._walk(label, is_root=True)
            if node is not None:
                roots.append(node)

        return roots

    def _brep_roots(self, shape: TopoDS_Shape) -> list[SceneNode]:
        """BREP: every solid as a root node, as importer-brep.cpp's single node.

        importer-brep.cpp has ONE root node, unnamed, whose meshes are the solids;
        cadResultToGroup turns it into a group named after the file. The glTF
        scene IS that group (GLTFLoader's `gltf.scene`, named from the scene name
        this service writes), so the solids hang off the scene directly rather
        than off a wrapper node the browser path does not have. The Y-up rotation
        goes into each of their matrices instead — see `pre_trsf`.
        """
        return self._mesh_children(None, shape, name="", pre_trsf=Y_UP_TRSF)

    # ── the label tree ─────────────────────────────────────────────────────

    def _walk(self, label: TDF_Label, *, is_root: bool) -> SceneNode | None:
        name = self._label_name(label)
        shape = self.shape_tool.GetShape_s(label)
        if shape.IsNull():
            return None

        is_mesh_node = self._is_mesh_node(label)
        if is_mesh_node:
            children = self._mesh_children(label, shape, name=name)
        else:
            children = []
            iterator = TDF_ChildIterator(label)
            while iterator.More():
                child = iterator.Value()
                iterator.Next()
                # XcafNode::GetChildren keeps only free-shape children, which is
                # what stops a master label being walked twice: once as the
                # assembly's own child and once through the instance that refers
                # to it.
                if not self._is_free_shape(child):
                    continue
                node = self._walk(child, is_root=False)
                if node is not None:
                    children.append(node)

        if not children:
            # buildSceneTree drops a node with no renderable descendant
            # (hasRenderableDescendant in utils/modelLoader.ts), so an empty
            # assembly must not become an empty glTF node either.
            return None

        only = children[0]
        if is_mesh_node and len(children) == 1 and only.mesh is not None and not only.children:
            # One part, so no group around it. The browser makes Group("Base
            # Plate") > Mesh("Base Plate") and collapseSingleChildGroups turns
            # that into a single MESH row; a GLB has to arrive already collapsed,
            # because GLTFLoader gives every node a UNIQUE name and the inner one
            # would come out as "Base_Plate_1" — which is then the name of the
            # row, since the collapse keeps a child's name unless it is a
            # "Mesh N" placeholder. The row keeps the MESH's name, not the
            # group's, because that is what the browser's collapse keeps.
            return SceneNode(
                name=only.name,
                transform=multiply_matrices(
                    self._node_transform(
                        label, shape, is_root=is_root, is_mesh_node=is_mesh_node
                    ),
                    only.transform,
                ),
                mesh=only.mesh,
            )

        return SceneNode(
            name=name,
            transform=self._node_transform(
                label, shape, is_root=is_root, is_mesh_node=is_mesh_node
            ),
            children=children,
        )

    def _mesh_children(
        self,
        label: TDF_Label | None,
        shape: TopoDS_Shape,
        *,
        name: str,
        pre_trsf: gp_Trsf | None = None,
    ) -> list[SceneNode]:
        """One child node per mesh of a mesh node.

        A glTF node holds at most one mesh, so the N meshes occt-import-js hangs
        off one node become N child nodes here. GLTFLoader turns a child node
        that has a mesh and no children of its own back into a THREE.Mesh, so the
        object the client ends up with is Group(name) > Mesh(…) — the same shape
        as cadResultToGroup's output, and the reason collapseSingleChildGroups in
        utils/modelLoader.ts exists ("CAD exports put each mesh in a same-named
        group").

        `label` is None for a BREP file, which has no document to look anything
        up in. `pre_trsf` is composed in FRONT of every child's own placement,
        which is how the root level gets the Y-up rotation without a wrapper node
        to hang it on.
        """
        # Strip this node's own placement so the enumeration below happens in the
        # frame the geometry is cached in; the placement itself goes on the node's
        # matrix (_node_transform). Stripping and re-applying the SAME location is
        # what makes an instance's mesh reusable: four bolts are four nodes
        # pointing at one mesh, each with its own matrix, and the vertex data
        # exists once.
        frame = shape.Located(IDENTITY_LOCATION)
        owner_key = self._owner_key(label) if label is not None else BREP_OWNER_KEY

        children = []
        for index, source in enumerate(_mesh_sources(frame)):
            # cadToThree's meshFrom is called with nextPart.value++ for every
            # mesh in the node's list, INCLUDING one whose geometry turns out to
            # be unusable, so the counter advances before the cache lookup.
            self.part_number += 1

            # The placement of this mesh inside the node, from the subshape's own
            # location. Not cached: two instances of one bolt share geometry but
            # sit in different places.
            location = IDENTITY_LOCATION if source.loose_faces else source.shape.Location()
            child_trsf = (
                None if location.IsIdentity() else location.Transformation()
            )
            if pre_trsf is not None:
                child_trsf = (
                    pre_trsf if child_trsf is None else pre_trsf.Multiplied(child_trsf)
                )
            transform = None if child_trsf is None else _matrix(child_trsf)

            key = self._mesh_key(source, owner_key, index)
            cached = self.mesh_cache.get(key)
            if cached is None:
                cached = self._build_mesh(source)
                self.mesh_cache[key] = cached
            if cached.geometry is None:
                continue

            children.append(
                SceneNode(
                    # meshFrom's fallback chain: the mesh's own name, then the
                    # node's, then "Part N".
                    name=cached.name or name or f"Part {self.part_number}",
                    transform=transform,
                    mesh=cached.geometry,
                )
            )
        return children

    def _mesh_key(self, source: _MeshSource, owner_key: str, index: int) -> tuple[str, int]:
        """The cache key that decides which parts share a tessellation.

        A solid that IS a labelled shape — the usual case for a fastener used
        fifty times — keys on that label, so every instance of it in the whole
        assembly lands on one entry. That is the requirement this service exists
        to satisfy: XDE says these are instances of the same shape, so the GLB
        says they are nodes on one mesh.

        `findSubshape=False` is what keeps this safe. Without it, a solid that is
        only PART of a labelled compound would resolve to the compound's label and
        every solid in that compound would collide on one key — one of them
        keeping its geometry and the rest silently disappearing. A solid with no
        label of its own falls back to (the node's owner, its index in the
        enumeration), which is stable because the enumeration order comes from
        the same shape every time.
        """
        if self.shape_tool is not None and not source.loose_faces:
            label = TDF_Label()
            if self.shape_tool.Search(source.shape, label, False, True, False):
                # Through _owner_key, not the label Search returned: for a part
                # placed directly in an assembly, Search finds the COMPONENT, and
                # one component per instance would defeat the sharing. Following
                # the reference lands on the master every instance shares.
                return (self._owner_key(label), 0)
        return (owner_key, index)

    def _build_mesh(self, source: _MeshSource) -> _CachedMesh:
        """Tessellate one mesh source, or return an empty cache entry."""
        # A BREP file has no XDE document, so there is nothing to look a name or
        # a colour up in — which is exactly what importer-brep.cpp's meshes
        # report: no name, no colour.
        has_document = self.shape_tool is not None

        if source.loose_faces:
            # XcafStandaloneFacesMesh: no name and no colour of its own, and no
            # placement (the loose faces are enumerated where they already are).
            geometry_shape = source.shape
            name = ""
            mesh_colour = None
        else:
            geometry_shape = source.shape.Located(IDENTITY_LOCATION)
            name = self._shape_name(source.shape) if has_document else ""
            mesh_colour = self._shape_colour(source.shape) if has_document else None

        positions, normals, indices, spans = _tessellate_faces(
            geometry_shape,
            loose_faces=source.loose_faces,
            face_colour=self._shape_colour if has_document else None,
        )
        # geometryFrom in cadToThree.ts returns null unless there is at least a
        # vertex and a triangle to draw.
        if len(positions) < 9 or len(indices) < 3:
            return _CachedMesh(None, name)

        geometry = MeshGeometry(
            name=name,
            positions=positions,
            normals=normals if len(normals) else None,
            primitives=_primitives(spans, indices, mesh_colour),
        )
        return _CachedMesh(geometry, name)

    # ── XDE lookups ────────────────────────────────────────────────────────

    def _is_free_shape(self, label: TDF_Label) -> bool:
        """IsFreeShape in importer-xcaf.cpp: it has a shape and nothing refers to it."""
        probe = TopoDS_Shape()
        if not self.shape_tool.GetShape_s(label, probe):
            return False
        return self.shape_tool.IsFree_s(label)

    def _is_mesh_node(self, label: TDF_Label) -> bool:
        """XcafNode::IsMeshNode, in one pass instead of its two.

        A label is a mesh node when it has no children at all, when one of its
        children is a SUBSHAPE label (a face or solid pulled out for its own
        name), or when none of its children is a free shape. The last rule is why
        an instance of an assembly flattens: a reference label has no children of
        its own — they belong to the master — so every solid inside it becomes a
        mesh of this one node.
        """
        if not label.HasChild():
            return True

        has_subshape_child = False
        has_free_shape_child = False
        iterator = TDF_ChildIterator(label)
        while iterator.More():
            child = iterator.Value()
            iterator.Next()
            if self.shape_tool.IsSubShape_s(child):
                has_subshape_child = True
                break
            if self._is_free_shape(child):
                has_free_shape_child = True

        if has_subshape_child:
            return True
        return not has_free_shape_child

    def _node_transform(
        self,
        label: TDF_Label,
        shape: TopoDS_Shape,
        *,
        is_root: bool,
        is_mesh_node: bool,
    ) -> tuple[float, ...] | None:
        """This node's matrix: its XDE placement, with Y-up folded in at the root.

        Applying the −90° rotation to the ROOT nodes rather than to the geometry
        is what makes it correct for a placed part: rotating a part's vertices
        about the world origin would move it as well as tipping it. This is the
        same reason parseModelFile applies Z_UP_TO_Y_UP to the loaded group
        instead of to each mesh.
        """
        # A MESH node's matrix must be the exact complement of the strip in
        # _mesh_children, so it comes from the shape's own top-level location:
        # stripping that location and re-applying it is a no-op by construction,
        # whatever the shape arrived with. An ASSEMBLY node keeps its children
        # in the parent's frame instead, so its placement is the XDE location
        # attribute, which is what that attribute means.
        location = (
            shape.Location() if is_mesh_node else self.shape_tool.GetLocation_s(label)
        )
        trsf = location.Transformation()
        if is_root:
            return _matrix(Y_UP_TRSF.Multiplied(trsf))
        return _matrix_of_location(location)

    def _owner_key(self, label: TDF_Label) -> str:
        """The label the geometry of a mesh node really comes from.

        Following references here is what makes instances share meshes: two
        components of one master produce the same key, so the second one reuses
        the first one's tessellation and only its matrix differs. Without it a
        5 000-fastener assembly would carry 5 000 copies of the same bolt.
        """
        referred = TDF_Label()
        if self.shape_tool.IsReference_s(label) and self.shape_tool.GetReferredShape_s(
            label, referred
        ):
            return self._owner_key(referred)
        return _entry_of(label)

    def _label_name(self, label: TDF_Label) -> str:
        """GetLabelName in importer-xcaf.cpp: the name of the shape, not of the instance.

        Following the reference is what occt-import-js does, so two instances of
        one part are named after their master and both read the same in the model
        tree. A reference whose master cannot be resolved has no name, which is
        also what the C++ produces (it recurses into a null label and finds no
        attribute).
        """
        if self.shape_tool.IsReference_s(label):
            referred = TDF_Label()
            if not self.shape_tool.GetReferredShape_s(label, referred):
                return ""
            return self._label_name(referred)
        return _name_attribute(label)

    def _shape_name(self, shape: TopoDS_Shape) -> str:
        """GetShapeName: the name of the label a shape belongs to, if it has one.

        A solid that is not itself labelled — the usual case for a solid inside
        an assembly — resolves to nothing, and meshFrom then falls back to the
        node's name. That fallback is why the browser's tree shows
        "Hook Left" > "Hook Left" for a single-solid part.
        """
        label = TDF_Label()
        if not self.shape_tool.Search(shape, label):
            return ""
        return self._label_name(label)

    def _label_colour(self, label: TDF_Label) -> Colour | None:
        """GetLabelColor: surface, then curve, then generic; then follow references.

        The three colour types in that order are exactly the list in
        importer-xcaf.cpp, and so is the reference fallback — a component's colour
        lives on its master. XCAFDoc_ColorTool.GetColor does NOT follow
        references itself, which is why the recursion is here.
        """
        for kind in (XCAFDoc_ColorSurf, XCAFDoc_ColorCurv, XCAFDoc_ColorGen):
            colour = Quantity_Color()
            if self.color_tool.GetColor_s(label, kind, colour):
                return Colour(colour.Red(), colour.Green(), colour.Blue())

        if self.shape_tool.IsReference_s(label):
            referred = TDF_Label()
            if self.shape_tool.GetReferredShape_s(label, referred):
                return self._label_colour(referred)
        return None

    def _shape_colour(self, shape: TopoDS_Shape) -> Colour | None:
        """GetShapeColor: the colour of the label this shape belongs to, if any."""
        label = TDF_Label()
        if not self.shape_tool.Search(shape, label):
            return None
        return self._label_colour(label)


# ─── Small helpers ──────────────────────────────────────────────────────────


def _entry_of(label: TDF_Label) -> str:
    """A label's entry ("0:1:1:2") — its identity within one document.

    Used as a cache key, never written to the output: entries are an artefact of
    how the reader happened to build the tree, so two runs of two different
    readers can number the same assembly differently.
    """
    entry = TCollection_AsciiString()
    TDF_Tool.Entry_s(label, entry)
    return entry.ToCString()


def _name_attribute(label: TDF_Label) -> str:
    """The TDataStd_Name on a label, or "".

    The IsAttribute guard is not a tidy-up: OCP's FindAttribute binding segfaults
    when the label does not carry the attribute (found while probing the API on
    OCP 8.0.1), and a segfault in the worker is a 500 for a file that only
    happens to be unnamed.
    """
    if label.IsNull() or not label.IsAttribute(TDataStd_Name.GetID_s()):
        return ""
    attribute = TDataStd_Name()
    if not label.FindAttribute(TDataStd_Name.GetID_s(), attribute):
        return ""
    # UTF-8, the way importer-xcaf.cpp reads it: a part name can be any Unicode
    # string, and a Japanese or Czech assembly is not a special case.
    return TCollection_AsciiString(attribute.Get()).ToCString()


def _iter_mesh_nodes(roots: list[SceneNode]):
    """Every node carrying a mesh, depth-first — the parts a client can pick."""
    for root in roots:
        yield from _iter_subtree(root)


def _iter_subtree(node: SceneNode):
    if node.mesh is not None:
        yield node
    for child in node.children:
        yield from _iter_subtree(child)

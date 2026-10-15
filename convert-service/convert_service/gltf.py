"""Write a tessellated assembly out as a binary glTF (GLB).

pygltflib rather than trimesh, and the reason is the shape of the output this
service owes the app:

  * A part whose faces carry two colours has to be ONE glTF mesh with TWO
    primitives — that is what becomes one THREE.Mesh with a material array and
    two geometry groups, which is exactly what `materialsFor` in
    utils/cadToThree.ts builds today. trimesh models one geometry (one material)
    per node, so the same part would arrive as two sibling meshes and the model
    tree would gain a row the browser path does not have.
  * Several nodes must be able to point at ONE mesh index, so a repeated part
    costs geometry once. That falls out of sharing a `MeshGeometry` instance:
    the writer deduplicates by object identity.
  * Every node needs a name, because gltfpack's `-kn` keeps named nodes and
    merges unnamed ones — and merging is what would destroy per-part identity.

pygltflib is a pure-Python set of glTF dataclasses with no numpy, so the buffers
here are `array.array('f')`/`array.array('I')`: four bytes per float instead of a
24-byte Python object, which is the difference between holding a 200 MB assembly
in memory and holding three copies of it.

Coordinate and colour conventions, both of which the app depends on:

  * glTF is Y-up and right-handed, like three.js. OpenCascade (and every CAD
    kernel behind a STEP file) is Z-up. The ROTATION is applied by cad.py to the
    root nodes' transforms, not here: this module writes the matrices it is
    given. `upAxisFor` in utils/modelFormats.ts is what tells the browser to
    rotate a CAD import, and a GLB must arrive already rotated so that it does
    not happen twice.
  * glTF colours are LINEAR; OpenCascade reports sRGB, and cadToThree.ts feeds
    them to `THREE.Color.setRGB(..., SRGBColorSpace)`. So the sRGB→linear
    conversion lives in `Colour.linear` and the client gets back the colour the
    browser path would have shown.
"""

from __future__ import annotations

from array import array
from dataclasses import dataclass, field
from pathlib import Path

import pygltflib

#: What the api sets on the response it forwards (task 03b), and what a client
#: must send to be handed these bytes back unchanged.
GLB_CONTENT_TYPE = "model/gltf-binary"

GLTF_VERSION = "2.0"

#: The shading cadToThree.ts gives a CAD part: `materialFor` builds a
#: MeshStandardMaterial with metalness 0.2, roughness 0.6 and DoubleSide.
#: modelLoader.ts forces DoubleSide on every imported mesh anyway, but writing
#: it here means the GLB looks right in any viewer, not only in this app.
METALLIC_FACTOR = 0.2
ROUGHNESS_FACTOR = 0.6

#: The grey every other importer uses for untextured geometry — `neutralColor()`
#: in utils/cadToThree.ts, and `neutralModelMaterial()` in utils/modelLoader.ts.
NEUTRAL_COLOUR = (0.7, 0.7, 0.75)


def _srgb_to_linear(channel: float) -> float:
    """One sRGB channel to linear, the inverse of what three.js does on the way in.

    The piecewise curve is the sRGB transfer function, not a 2.2 power: three's
    `SRGBToLinear` uses exactly this, so a colour that goes browser→sRGB→linear
    here comes back bit-for-bit comparable on the client.
    """
    if channel <= 0.04045:
        return channel / 12.92
    return ((channel + 0.055) / 1.055) ** 2.4


@dataclass(frozen=True)
class Colour:
    """An sRGB colour in 0..1, exactly as OpenCascade reports it."""

    r: float
    g: float
    b: float

    @classmethod
    def neutral(cls) -> Colour:
        return cls(*NEUTRAL_COLOUR)

    @property
    def key(self) -> str:
        """The deduplication key. Mirrors `colorKey` in utils/cadToThree.ts.

        Four decimals, because that is what the browser path compares and a
        colour that differs in the sixth decimal is the same paint to a
        reviewer.
        """
        return ",".join(f"{value:.4f}" for value in (self.r, self.g, self.b))

    @property
    def linear(self) -> tuple[float, float, float, float]:
        """baseColorFactor: linear RGB plus an opaque alpha."""
        return (
            _srgb_to_linear(self.r),
            _srgb_to_linear(self.g),
            _srgb_to_linear(self.b),
            1.0,
        )

    @property
    def hex_name(self) -> str:
        """A material name a person can read, from the sRGB value."""
        return "colour-{:02x}{:02x}{:02x}".format(
            *(max(0, min(255, round(channel * 255))) for channel in (self.r, self.g, self.b))
        )


def multiply_matrices(
    a: tuple[float, ...] | None, b: tuple[float, ...] | None
) -> tuple[float, ...] | None:
    """Column-major a·b, where None is the identity.

    Used when a group holding exactly one part is merged into that part: the two
    placements have to compose, and neither is necessarily the identity.
    """
    if a is None:
        return b
    if b is None:
        return a
    return tuple(
        sum(a[k * 4 + row] * b[column * 4 + k] for k in range(4))
        for column in range(4)
        for row in range(4)
    )


@dataclass
class Primitive:
    """One draw call: a colour and the triangles painted with it.

    `indices` are indices into the parent mesh's position/normal arrays, in the
    order the faces were enumerated — the equivalent of one entry in
    `geometry.groups` on the browser side.
    """

    colour: Colour
    indices: array  # array('I')


@dataclass
class MeshGeometry:
    """One glTF mesh: a shared vertex buffer and one primitive per colour.

    Instances are SHARED between nodes on purpose (see the module docstring):
    two nodes holding the same object become two glTF nodes pointing at one mesh
    index, which is the free instancing the later tasks build on.
    """

    name: str
    positions: array  # array('f'), xyz triples
    normals: array | None  # array('f'), xyz triples — None when incomplete
    primitives: list[Primitive] = field(default_factory=list)

    @property
    def vertex_count(self) -> int:
        return len(self.positions) // 3

    @property
    def triangle_count(self) -> int:
        return sum(len(primitive.indices) for primitive in self.primitives) // 3


@dataclass
class SceneNode:
    """A node in the assembly tree.

    `transform` is a 16-float glTF matrix in COLUMN-major order, or None for the
    identity (omitted from the file, which is both smaller and what gltfpack
    expects of a node it may merge).
    """

    name: str
    transform: tuple[float, ...] | None = None
    mesh: MeshGeometry | None = None
    children: list[SceneNode] = field(default_factory=list)


@dataclass(frozen=True)
class WriteResult:
    """What the writer counted, for the response headers and the tests.

    `buffer_bytes` is the BIN chunk, not the file: the file also carries the JSON
    chunk and two headers. Callers that report a size stat the file.
    """

    buffer_bytes: int
    node_count: int
    part_count: int
    unique_meshes: int
    triangle_count: int


class _Writer:
    """Flattens a SceneNode tree into pygltflib's index-based tables."""

    def __init__(self) -> None:
        self.nodes: list[pygltflib.Node] = []
        self.meshes: list[pygltflib.Mesh] = []
        self.materials: list[pygltflib.Material] = []
        self.accessors: list[pygltflib.Accessor] = []
        self.buffer_views: list[pygltflib.BufferView] = []
        self.blob = bytearray()
        # Meshes and materials are deduplicated by identity and by colour
        # respectively, so a repeated part writes its geometry once and two
        # parts of the same paint share one material.
        self._mesh_index: dict[int, int] = {}
        self._material_index: dict[str, int] = {}
        self.part_count = 0
        self.triangle_count = 0

    # ── buffer plumbing ─────────────────────────────────────────────────────

    def _append(self, data: array, target: int) -> int:
        """Append one typed array to the BIN chunk and return its bufferView index.

        Every array written here is 4-byte elements (float32, uint32), and the
        GLB chunk itself starts 4-byte aligned, so byteOffset needs no padding to
        satisfy glTF's alignment rule. That invariant is worth stating because it
        is the only reason there is no alignment code: a byte-sized accessor
        (a colour as uint8, say) would need it.
        """
        byte_length = data.itemsize * len(data)
        offset = len(self.blob)
        self.blob += data.tobytes()
        self.buffer_views.append(
            pygltflib.BufferView(
                buffer=0,
                byteOffset=offset,
                byteLength=byte_length,
                target=target,
            )
        )
        return len(self.buffer_views) - 1

    def _accessor(
        self,
        data: array,
        *,
        count: int,
        component_type: int,
        accessor_type: str,
        target: int,
        bounds: tuple[list[float], list[float]] | None = None,
    ) -> int:
        view = self._append(data, target)
        minimum, maximum = bounds if bounds is not None else ([], [])
        self.accessors.append(
            pygltflib.Accessor(
                bufferView=view,
                componentType=component_type,
                count=count,
                type=accessor_type,
                # min/max are REQUIRED on a POSITION accessor by the glTF spec
                # (a viewer computes its bounds from them without reading the
                # data), and ignored elsewhere.
                min=minimum or None,
                max=maximum or None,
            )
        )
        return len(self.accessors) - 1

    # ── materials and meshes ────────────────────────────────────────────────

    def _material(self, colour: Colour) -> int:
        existing = self._material_index.get(colour.key)
        if existing is not None:
            return existing
        self.materials.append(
            pygltflib.Material(
                name=colour.hex_name,
                doubleSided=True,
                pbrMetallicRoughness=pygltflib.PbrMetallicRoughness(
                    baseColorFactor=list(colour.linear),
                    metallicFactor=METALLIC_FACTOR,
                    roughnessFactor=ROUGHNESS_FACTOR,
                ),
            )
        )
        index = len(self.materials) - 1
        self._material_index[colour.key] = index
        return index

    def _mesh(self, geometry: MeshGeometry) -> int:
        """The glTF mesh index for `geometry`, writing it only the first time."""
        existing = self._mesh_index.get(id(geometry))
        if existing is not None:
            return existing

        vertex_count = geometry.vertex_count
        bounds = _position_bounds(geometry.positions)
        position_accessor = self._accessor(
            geometry.positions,
            count=vertex_count,
            component_type=pygltflib.FLOAT,
            accessor_type=pygltflib.VEC3,
            target=pygltflib.ARRAY_BUFFER,
            bounds=bounds,
        )
        attributes = pygltflib.Attributes(POSITION=position_accessor)
        if geometry.normals is not None:
            attributes.NORMAL = self._accessor(
                geometry.normals,
                count=vertex_count,
                component_type=pygltflib.FLOAT,
                accessor_type=pygltflib.VEC3,
                target=pygltflib.ARRAY_BUFFER,
            )

        primitives = []
        for primitive in geometry.primitives:
            indices = self._accessor(
                primitive.indices,
                count=len(primitive.indices),
                component_type=pygltflib.UNSIGNED_INT,
                accessor_type=pygltflib.SCALAR,
                target=pygltflib.ELEMENT_ARRAY_BUFFER,
            )
            primitives.append(
                pygltflib.Primitive(
                    attributes=attributes,
                    indices=indices,
                    material=self._material(primitive.colour),
                    mode=pygltflib.TRIANGLES,
                )
            )

        self.meshes.append(pygltflib.Mesh(name=geometry.name, primitives=primitives))
        index = len(self.meshes) - 1
        self._mesh_index[id(geometry)] = index
        return index

    # ── the tree ────────────────────────────────────────────────────────────

    def add(self, node: SceneNode) -> int:
        """Reserve this node's index, then its children (glTF is pre-order)."""
        index = len(self.nodes)
        self.nodes.append(pygltflib.Node(name=node.name))

        mesh_index = None
        if node.mesh is not None:
            mesh_index = self._mesh(node.mesh)
            self.part_count += 1
            self.triangle_count += node.mesh.triangle_count

        children = [self.add(child) for child in node.children]

        written = self.nodes[index]
        written.mesh = mesh_index
        written.children = children or None
        written.matrix = list(node.transform) if node.transform is not None else None
        return index


def _position_bounds(positions: array) -> tuple[list[float], list[float]]:
    """min/max per axis, for the POSITION accessor.

    Three strided slices rather than one Python loop over the interleaved
    floats: the slices are C-speed copies of a third of the array each, and on a
    large assembly that is seconds instead of minutes. The cost is one extra copy
    of the position data, briefly, per mesh.
    """
    bounds = []
    for axis in range(3):
        values = positions[axis::3]
        bounds.append((float(min(values)), float(max(values))) if values else (0.0, 0.0))
    return ([low for low, _ in bounds], [high for _, high in bounds])


def write_glb(
    roots: list[SceneNode],
    destination: Path,
    *,
    scene_name: str = "",
    generator: str,
) -> WriteResult:
    """Write `roots` as one GLB with a single scene.

    The scene itself plays the part of occt-import-js's unnamed root node: its
    `nodes` are the file's free shapes, which is what `cadResultToGroup` puts
    inside the group it returns. `scene_name` is the name that group would have
    got — the file's base name — so a client that wraps gltf.scene in nothing
    still sees the assembly named the way the browser path names it.
    """
    writer = _Writer()
    root_indices = [writer.add(root) for root in roots]

    blob = bytes(writer.blob)
    gltf = pygltflib.GLTF2(
        asset=pygltflib.Asset(version=GLTF_VERSION, generator=generator),
        scene=0,
        scenes=[pygltflib.Scene(name=scene_name or None, nodes=root_indices)],
        nodes=writer.nodes,
        meshes=writer.meshes,
        materials=writer.materials,
        accessors=writer.accessors,
        bufferViews=writer.buffer_views,
        buffers=[pygltflib.Buffer(byteLength=len(blob))],
    )
    gltf.set_binary_blob(blob)
    gltf.save_binary(destination)

    return WriteResult(
        buffer_bytes=len(blob),
        node_count=len(writer.nodes),
        part_count=writer.part_count,
        unique_meshes=len(writer.meshes),
        triangle_count=writer.triangle_count,
    )

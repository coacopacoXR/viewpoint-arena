"""The formats this service reads, and the OpenCascade reader each one needs.

One table, three readers of it: main.py (does this request name a format we
handle at all → 415), cad.py (which reader to construct) and the tests. Keeping
it here rather than inlining the extensions in each place is what stops the
service from accepting an upload it then cannot convert.

The list mirrors the browser's, on purpose and by name:

    CAD_EXTENSIONS          utils/modelFormats.ts
    READER_BY_EXTENSION     CAD_READER_BY_EXTENSION in utils/cadImport.ts
    READER_LABEL            CAD_READER_LABEL in utils/cadImport.ts

Task 03b wires the api to this service; the api decides WHICH files to send here
(the browser still reads a mesh format itself) but not what is readable, so the
two lists have to agree. tests/test_formats.py pins them against the TypeScript
source the way capture-service's test_typescript_parity.py pins its error codes.
"""

from __future__ import annotations

from pathlib import PurePosixPath

#: Every extension OpenCascade can open, lowercase and dot-prefixed.
CAD_EXTENSIONS: tuple[str, ...] = (".step", ".stp", ".iges", ".igs", ".brep", ".brp")

#: Reader keys, matching the `reader` values cad.py accepts.
READER_STEP = "step"
READER_IGES = "iges"
READER_BREP = "brep"

READER_BY_EXTENSION: dict[str, str] = {
    ".step": READER_STEP,
    ".stp": READER_STEP,
    ".iges": READER_IGES,
    ".igs": READER_IGES,
    ".brep": READER_BREP,
    ".brp": READER_BREP,
}

READER_LABEL: dict[str, str] = {
    READER_STEP: "STEP",
    READER_IGES: "IGES",
    READER_BREP: "BREP",
}


def extension_of(file_name: str | None) -> str:
    """The lowercase extension of a client-supplied name, or "".

    Backslashes are normalised first: a Windows browser can send a path in
    X-File-Name, and PurePosixPath would treat the whole thing as one component
    and report no extension at all. The value is untrusted text — this function
    only ever returns a suffix, never a path, and nothing here touches a
    filesystem with it (main.py spools the upload under its own temp name).
    """
    if not file_name:
        return ""
    return PurePosixPath(file_name.replace("\\", "/")).suffix.lower()


def reader_for(file_name: str | None) -> str | None:
    """The reader a filename needs, or None if this service cannot read it."""
    return READER_BY_EXTENSION.get(extension_of(file_name))


def base_name_of(file_name: str | None) -> str:
    """The filename without its extension, for the scene's own name.

    Mirrors `baseNameOf` in utils/modelLoader.ts, which is what the browser path
    names the CAD root group when the file carries no name of its own
    (cadResultToGroup's `fallbackName`). Naming the glTF scene the same way is
    what makes a converted file's tree read like a browser-imported one.
    """
    if not file_name:
        return ""
    normalised = file_name.replace("\\", "/")
    name = PurePosixPath(normalised).name
    suffix = PurePosixPath(name).suffix
    if suffix and suffix != name:
        return name[: -len(suffix)]
    return name

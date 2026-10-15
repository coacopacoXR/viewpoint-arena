import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import { useStore, sceneModelVisible, type SceneModelEntry } from '../../store';
import type { SceneModel } from '../../lib/scene/roomScene';
import { sceneModelTransform } from '../../lib/scene/roomScene';
import { applyPartTransforms } from '../../lib/scene/partTransforms';
import { modelBox, type PartRegistry } from '../../lib/scene/partRegistry';

/**
 * The selection glow for an imported model, as one object rather than per-mesh values.
 *
 * Allocated once here because it is handed to the registry on every state change, and
 * the version this replaced built two THREE.Colors per mesh per pass. The same blue the
 * bundled synth declares in its own JSX (`#0044aa` in components/Scene/Product.tsx),
 * because one selection has one colour whichever model it is on.
 */
const SELECTION_HIGHLIGHT = { color: new THREE.Color(0x0044aa), intensity: 0.5 };

/**
 * Scale the imported model and put it centred on the origin, resting on the
 * floor. basePosition is -centre in the model's OWN units; the group is scaled,
 * so the offset is scaled with it. Unscaled, a model far from its origin (a CAD
 * part in millimetres, 100 mm out) was pushed ~100 scene units away and never
 * appeared.
 *
 * Places the model at the ORIGIN of whatever group holds it. Where in the room
 * that is comes from the SceneModel's offset, applied by the wrapper group in
 * SceneModelView below — so a model can be put beside another without this
 * having to know anything about the models around it.
 *
 * The floor is found through the model's registry, which is the only thing that can
 * answer once a part stops being an Object3D of its own: `Box3.setFromObject` walks a
 * geometry, and a BatchedMesh's geometry is the concatenated buffer in the batch's own
 * space, so measuring that would drop the model on a floor no part is standing on (the
 * render audit's R1). Null for a hand-built entry with no registry, which is a test
 * fixture and nothing in the app.
 */
export function placeImportedGroup(
    group: THREE.Object3D,
    scale: number,
    basePosition: THREE.Vector3 | null,
    registry: PartRegistry | null,
): void {
    group.scale.setScalar(scale);
    if (basePosition) group.position.copy(basePosition).multiplyScalar(scale);
    group.updateMatrixWorld(true);
    const box = modelBox(group, registry, new THREE.Box3());
    group.position.y -= box.min.y;
}

/**
 * One model of the scene, at its offset.
 *
 * Its own component rather than a loop body because each one carries three
 * effects that must run against ITS geometry and nothing else's: the placement,
 * the point-of-interest registration the agents and the laser target, and the
 * walk that applies node visibility and the selection glow. Sharing one set of
 * refs across models is how the second model would have ended up registered
 * against the first one's meshes.
 */
const SceneModelView: React.FC<{ model: SceneModel; entry: SceneModelEntry; label: string | null }> = ({
    model,
    entry,
    label,
}) => {
    const objectStates = useStore(state => state.objectStates);
    const registerPOI = useStore(state => state.registerPOI);
    const registerSceneModelGroup = useStore(state => state.registerSceneModelGroup);
    const groupRef = useRef<THREE.Group>(null);
    // The wrapper, which is the object carrying this model's own transform and
    // therefore the one the amber strip's gizmo has to drag. Registered so the
    // gizmo — a sibling of this component inside the canvas, with no prop path to
    // it — can find it by model id.
    const wrapperRef = useRef<THREE.Group>(null);
    const registeredIds = useRef<Set<string>>(new Set());

    useEffect(() => {
        const group = wrapperRef.current;
        if (!group) return;
        registerSceneModelGroup(model.id, group);
        return () => registerSceneModelGroup(model.id, null);
    }, [model.id, registerSceneModelGroup]);

    useEffect(() => {
        if (!groupRef.current) return;
        placeImportedGroup(
            groupRef.current,
            entry.scale * entry.baseScale,
            entry.basePosition,
            entry.partRegistry ?? null,
        );
    }, [entry]);

    /**
     * The parts of this model somebody moved on their own — batch BR.
     *
     * Declared AFTER the placement above and BEFORE the point-of-interest walk below,
     * and the order is the whole of the contract: placement scales and centres the
     * group and computes where the floor is from the geometry as the FILE has it, so
     * a moved part must not change that (pulling one flange out would otherwise slide
     * the whole product sideways); and the POIs are world-space centres the agents and
     * the laser aim at, so they have to be measured after the parts have moved or the
     * laser would point at where a part used to be.
     *
     * `model.parts` is a fresh object only when the reducer actually changed it, which
     * is what makes this effect cheap: a SCENE_STATE relayed for something else leaves
     * the reference alone and this does not run.
     */
    useEffect(() => {
        applyPartTransforms(entry.group, model.parts);
    }, [entry, model.parts]);

    useEffect(() => {
        if (!groupRef.current) return;
        registeredIds.current.clear();

        groupRef.current.traverse(child => {
            if (child instanceof THREE.Mesh) {
                const id = child.userData.modelId as string | undefined;
                if (!id || registeredIds.current.has(id)) return;
                const box = new THREE.Box3().setFromObject(child);
                const center = box.getCenter(new THREE.Vector3());
                registerPOI({
                    id,
                    position: center,
                    label: child.name || id,
                    type: 'GENERAL'
                });
                registeredIds.current.add(id);
            }
        });
    }, [registerPOI, entry, model.parts]);

    /**
     * Node visibility and the selection glow, as writes to the parts whose state moved.
     *
     * This used to be a recursive walk over every object of this model on every change
     * to `objectStates` ANYWHERE in the scene, and the walk wrote to every material it
     * passed: a 40 000-part assembly re-touched 40 000 materials each time somebody two
     * models away clicked a row. The registry keeps the state it last applied, diffs the
     * tree's own two booleans against it, and writes only the parts whose EFFECTIVE value
     * moved plus the subtrees under them — both visibility and selection inherit
     * downward, so a group is a subtree and a leaf is one part. One click is two parts.
     *
     * The glow is per PART now, which is the fix for the render audit's D1. It used to be
     * written onto the Material, and materials are shared: `ensureMeshMaterial` hands
     * back the same object for anything already standard, so a file whose 400 bolts share
     * one material had one Material between them and selecting a bolt lit all 400. A
     * highlighted part is drawn from a private clone instead, and every other part keeps
     * the file's own.
     *
     * Still subscribed to the whole `objectStates` map rather than to this model's ids,
     * because a zustand selector that picked out a sub-record would answer a fresh object
     * on every change anywhere and re-render on all of them anyway. The subscription is
     * the cheap half; the walk it used to trigger was not.
     */
    useEffect(() => {
        if (!groupRef.current) return;
        entry.partRegistry?.syncStates(objectStates, SELECTION_HIGHLIGHT);
    }, [objectStates, entry]);

    // Above the model, in scene units: the geometry is scaled inside the group,
    // the label is a sibling of it, so it is measured from the same numbers
    // placement uses rather than inheriting a scale that would grow the text.
    const labelY = entry.size.y * entry.baseScale * entry.scale + 0.15;

    // The room's own transform for this model — where the amber strip's Move /
    // Rotate / Scale left it. Read through sceneModelTransform so a model written
    // before batch BH, which has neither field, stands exactly as it arrived.
    // Applied to the WRAPPER rather than to the geometry inside it: that group is
    // already scaled and centred by placeImportedGroup, and scaling it again
    // would scale the centring with it and slide the model off its own origin.
    const transform = sceneModelTransform(model);

    return (
        <group ref={wrapperRef} position={transform.offset} rotation={transform.rotation} scale={transform.scale}>
            <primitive ref={groupRef} object={entry.group} />
            {label && (
                <Html
                    position={[0, labelY, 0]}
                    center
                    distanceFactor={6}
                    style={{ pointerEvents: 'none' }}
                    zIndexRange={[0, 0]}
                >
                    <div
                        style={{
                            background: 'rgba(0,0,0,0.7)',
                            color: '#fff',
                            fontFamily: 'monospace',
                            fontSize: '7px',
                            padding: '1px 4px',
                            borderRadius: '3px',
                            whiteSpace: 'nowrap',
                        }}
                    >
                        {label}
                    </div>
                </Html>
            )}
        </group>
    );
};

/**
 * Every model the room's scene is showing.
 *
 * Renders nothing when the scene holds no models, which is what lets World mount
 * it unconditionally next to the built-ins: a room looking at the bundled
 * headphones has an empty list and this is an empty fragment.
 *
 * A model that is hidden is not rendered at all rather than rendered invisible,
 * so its meshes stay out of the raycast — pointing at where a hidden model was
 * should point at whatever is behind it, which is why somebody hid it.
 */
const ImportedModel: React.FC = () => {
    const scene = useStore(state => state.scene);
    const sceneEntries = useStore(state => state.sceneEntries);
    const localModelVisibility = useStore(state => state.localModelVisibility);

    const shown = scene.models.filter(model => {
        if (!sceneEntries[model.id]) return false;
        return sceneModelVisible(model, localModelVisibility);
    });
    if (shown.length === 0) return null;

    // A revision is only ambiguous when another one of the same product is on
    // screen beside it, so that is when it gets a label. Derived from the shared
    // scene rather than from whoever pressed Compare: the comparison is a scene
    // operation, and a label only one participant can see would have the room
    // looking at two brackets and arguing about which is which.
    const visiblePerLine = new Map<string, number>();
    for (const model of shown) {
        visiblePerLine.set(model.line, (visiblePerLine.get(model.line) ?? 0) + 1);
    }

    return (
        <>
            {shown.map(model => (
                <SceneModelView
                    key={model.id}
                    model={model}
                    entry={sceneEntries[model.id]}
                    label={(visiblePerLine.get(model.line) ?? 0) > 1 ? `Rev ${model.revision}` : null}
                />
            ))}
        </>
    );
};

export default ImportedModel;

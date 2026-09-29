import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import { useStore, sceneModelVisible, type SceneModelEntry } from '../../store';
import type { SceneModel } from '../../lib/scene/roomScene';
import { sceneModelTransform } from '../../lib/scene/roomScene';
import { applyPartTransforms } from '../../lib/scene/partTransforms';
import { setEmissiveHighlight } from '../../lib/scene/materialHighlight';

/**
 * The selection glow for an imported model, as one object rather than per-mesh values.
 *
 * Allocated once here because the walk that applies it runs over every mesh of every
 * model on every change to the tree's states, and the version this replaced built two
 * THREE.Colors per mesh per pass. The same blue the built-in samples use — see
 * SELECTION_GLOW in lib/builtInModelGlow.ts — because one selection has one colour
 * whichever model it is on.
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
 */
export function placeImportedGroup(group: THREE.Object3D, scale: number, basePosition: THREE.Vector3 | null): void {
    group.scale.setScalar(scale);
    if (basePosition) group.position.copy(basePosition).multiplyScalar(scale);
    group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(group);
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
        placeImportedGroup(groupRef.current, entry.scale * entry.baseScale, entry.basePosition);
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

    useEffect(() => {
        if (!groupRef.current) return;

        const updateVisibility = (object: THREE.Object3D, parentVisible: boolean, parentSelected: boolean) => {
            const id = object.userData.modelId as string | undefined;
            const state = id ? objectStates[id] : undefined;
            const isVisible = (state?.visible ?? true) && parentVisible;
            const isSelected = (state?.selected ?? false) || parentSelected;

            object.visible = isVisible;

            if (object instanceof THREE.Mesh) {
                const materials = Array.isArray(object.material) ? object.material : [object.material];
                // The selection glow, and the material's own emissive back again when
                // the selection moves on. It used to write black and zero here, which
                // is what an imported material's emissive "should" be and is not: a
                // file that gave a lens its glow, or a CAD export that marked a warning
                // stripe with one, came back from being selected once permanently dead.
                // lib/scene/materialHighlight remembers the original in userData the
                // first time it is asked, so the restore costs one lookup per material.
                materials.forEach(material => {
                    setEmissiveHighlight(material, isSelected ? SELECTION_HIGHLIGHT : null);
                });
            }

            object.children.forEach(child => updateVisibility(child, isVisible, isSelected));
        };

        updateVisibility(groupRef.current, true, false);
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

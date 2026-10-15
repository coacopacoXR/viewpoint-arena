import React, { useRef, useState, useEffect, useMemo } from 'react';
import {
    countParts,
    getCurrentSceneTree,
    SCENE_ROOT_ID,
    sceneEntryWidth,
    sceneModelVisible,
    useStore,
} from '../../store';
import { SceneNode } from '../../types';
import { ChevronRight, ChevronDown, Eye, EyeOff, Box, Layers, CircleDot, Upload, FileBox, Loader2, AlertCircle, AlertTriangle, CheckCircle2, X, GitCompare, Trash2, Users, Lock, Globe, Sparkles } from 'lucide-react';
import { clsx } from 'clsx';
import { largeCadWarningFor, parseModelFile, validateModelFile, type ModelImportResult } from '../../utils/modelLoader';
import { MODEL_FILE_ACCEPT } from '../../utils/modelFormats';
import { MODEL_UPLOAD_NETWORK_MESSAGE, uploadModelFile } from '../../lib/modelsClient';
import { usePresence } from '../../lib/PresenceContext';
import { useActiveReviewStore } from '../../lib/activeReviewStore';
import { useReviewSetupStore } from '../../lib/reviewSetupStore';
import { recordModelRevision } from '../../lib/reviews/revisionsRepo';
import {
    FIRST_REVISION,
    lineFromFileName,
    revisionTargets,
    nextRevisionFor,
    sceneModelId,
    sceneModelLabel,
    sceneModelPrefix,
    type ModelEditors,
    type SceneModel,
    type SceneUpdate,
} from '../../lib/scene/roomScene';
import { useScenePermissions } from '../../lib/scene/useScenePermissions';
import { useSceneEditHistory } from '../../lib/scene/useSceneEditHistory';
import { useSampleModels } from '../../lib/scene/useSampleModels';
import { claimImportPicker, claimSceneImports } from '../../lib/scene/importHandoff';
import { compareOffsets, nextToOffset, type SceneExtent } from '../../lib/scene/placement';
import { sceneModelEntry } from '../../lib/scene/sceneEntries';

// Find all ancestor ids of a node in the tree (excluding the node itself)
function findAncestorIds(root: SceneNode, targetId: string): string[] {
  const ancestors: string[] = [];

  function search(node: SceneNode, path: string[]): boolean {
    if (node.id === targetId) {
      ancestors.push(...path);
      return true;
    }
    if (node.children) {
      for (const child of node.children) {
        if (search(child, [...path, node.id])) return true;
      }
    }
    return false;
  }

  search(root, []);
  return ancestors;
}

/** The newest revision of a line, which is the one a new revision follows and hides. */
function latestOfLine(models: SceneModel[], line: string): SceneModel | null {
    let latest: SceneModel | null = null;
    for (const model of models) {
        if (model.line !== line) continue;
        const candidate = model.revision.trim().toUpperCase();
        const current = latest ? latest.revision.trim().toUpperCase() : '';
        if (!latest || candidate.length > current.length || (candidate.length === current.length && candidate > current)) {
            latest = model;
        }
    }
    return latest;
}

/**
 * One row of the Model Tree, and the reason it is memoised.
 *
 * A row's own state arrives through its own `objectStates[node.id]` subscription, so the
 * subscription — not the parent — is what has to decide whether this row re-renders.
 * Without the memo the opposite holds: SceneTree subscribes to state that moves for reasons
 * of its own (components/Scene/World.tsx writes the clock to the store ten times a second,
 * and every import control in this panel reads the scene), and one such write re-rendered
 * EVERY mounted row and the three or four lucide icons in each. Task 05c measured a
 * 3 200-part model with its tree open spending 92 ms of every frame in React with the laser
 * down and the pointer parked — 68% of the main thread, re-rendering rows nothing had
 * changed.
 *
 * The props are the two that are stable by construction: `node` is an object out of the
 * parsed scene tree, which is a new object only when the model is, and `depth` is a number.
 * So a memo compare is enough and the row re-renders exactly when its own entry does.
 */
const TreeNode: React.FC<{ node: SceneNode; depth: number }> = React.memo(({ node, depth }) => {
    const objectState = useStore(state => state.objectStates[node.id]);
    const toggleVisibility = useStore(state => state.toggleNodeVisibility);
    const toggleExpanded = useStore(state => state.toggleNodeExpanded);
    const selectNode = useStore(state => state.selectNode);
    const rowRef = useRef<HTMLDivElement>(null);
    const prevSelectedRef = useRef(false);

    const isGroup = node.type === 'GROUP';
    const isExpanded = objectState?.expanded ?? false;
    const isSelected = objectState?.selected ?? false;
    const isVisible = objectState?.visible ?? true;

    // Scroll into view when this node becomes selected (only on selection change)
    useEffect(() => {
      if (isSelected && !prevSelectedRef.current && rowRef.current) {
        rowRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
      prevSelectedRef.current = isSelected;
    }, [isSelected]);

    if (!objectState) return null;

    const handleToggleExpand = (e: React.MouseEvent) => {
        e.stopPropagation();
        toggleExpanded(node.id);
    };

    const handleToggleVis = (e: React.MouseEvent) => {
        e.stopPropagation();
        toggleVisibility(node.id);
    };

    const handleSelect = () => {
        selectNode(isSelected ? null : node.id);
    };

    return (
        <div className="flex flex-col select-none">
            <div
                ref={rowRef}
                className={clsx(
                    "flex items-center h-7 px-2 cursor-pointer transition-colors border-l-2",
                    isSelected
                        ? "bg-blue-50 border-blue-500"
                        : "hover:bg-gray-50 border-transparent"
                )}
                style={{ paddingLeft: `${depth * 12 + 4}px` }}
                onClick={handleSelect}
            >
                {/* Expand Toggle */}
                <div className="w-4 flex items-center justify-center mr-1" onClick={isGroup ? handleToggleExpand : undefined}>
                    {isGroup && (
                        isExpanded
                        ? <ChevronDown size={12} className="text-gray-500" />
                        : <ChevronRight size={12} className="text-gray-500" />
                    )}
                </div>

                {/* Type Icon */}
                <div className="mr-2 text-gray-500">
                    {node.type === 'GROUP' && <Layers size={12} />}
                    {node.type === 'MESH' && <Box size={12} />}
                    {node.type === 'PART' && <CircleDot size={12} />}
                </div>

                {/* Label */}
                <span className={clsx(
                    "text-[10px] font-mono truncate flex-1",
                    isSelected ? "font-bold text-blue-700" : "text-gray-700",
                    !isVisible && "opacity-50 line-through"
                )}>
                    {node.name}
                </span>

                {/* Visibility Toggle */}
                <div
                    className="w-5 h-5 flex items-center justify-center rounded hover:bg-gray-200 text-gray-400 hover:text-gray-700 ml-1"
                    onClick={handleToggleVis}
                >
                    {isVisible ? <Eye size={10} /> : <EyeOff size={10} />}
                </div>
            </div>

            {/* Children */}
            {isGroup && isExpanded && node.children && (
                <div className="flex flex-col relative">
                    {/* Tree Guide Line */}
                    <div className="absolute left-[calc(12px*var(--depth)+9px)] top-0 bottom-0 w-px bg-gray-200" style={{'--depth': depth} as React.CSSProperties}></div>
                    {node.children.map(child => (
                        <TreeNode key={child.id} node={child} depth={depth + 1} />
                    ))}
                </div>
            )}
        </div>
    );
});

/**
 * One top-level row per model in the scene: "Bracket · Rev B".
 *
 * Its eye is the one control here that means two different things, and the
 * difference is the point of the batch. Somebody who may change the room's
 * models sends setVisible, and everybody's screen changes. Somebody who may not
 * hides it on their own screen only — hiding a model so you can see the one
 * behind it is not a change to what the review is about, and locking that behind
 * the host's permission would have made a read-only guest unable to look at
 * their own picture.
 *
 * Memoised for the same reason TreeNode is, and it is the row that matters more: this is
 * the one that renders a model's whole part tree, so a re-render of it that its own props
 * did not ask for is a re-render of every row under it that the memo on TreeNode then has
 * to refuse one by one.
 */
const SceneModelRow: React.FC<{ model: SceneModel; onCompare: (line: string) => void }> = React.memo(({ model, onCompare }) => {
    const entry = useStore(state => state.sceneEntries[model.id]);
    const expanded = useStore(state => Boolean(state.expandedSceneModels[model.id]));
    const toggleExpanded = useStore(state => state.toggleSceneModelExpanded);
    const localModelVisibility = useStore(state => state.localModelVisibility);
    const setLocalModelVisibility = useStore(state => state.setLocalModelVisibility);
    const applyLocalSceneUpdate = useStore(state => state.applyLocalSceneUpdate);
    const setActiveSceneModel = useStore(state => state.setActiveSceneModel);
    const selectNode = useStore(state => state.selectNode);
    const revisionsInLine = useStore(state => state.scene.models.filter(m => m.line === model.line).length);
    const isComparing = useStore(state => state.compare?.line === model.line);
    const { broadcastSceneUpdate } = usePresence();
    const { canChangeModels, reason } = useScenePermissions();
    const { record } = useSceneEditHistory();

    const isVisible = sceneModelVisible(model, localModelVisibility);

    const handleToggleVis = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (canChangeModels) {
            const update: SceneUpdate = { op: 'setVisible', id: model.id, visible: !isVisible };
            // Remembered, like every other change to the shared scene: hiding a revision
            // so the one behind it can be seen is exactly the kind of thing somebody
            // wants back one press later, and the eye is not the only way it happens.
            record(isVisible ? `Hid ${sceneModelLabel(model)}` : `Showed ${sceneModelLabel(model)}`, [model.id], () => {
                broadcastSceneUpdate(update);
                applyLocalSceneUpdate(update);
            });
        } else {
            // Local only, and deliberately so — see the comment on this component.
            setLocalModelVisibility(model.id, !isVisible);
        }
    };

    const handleRemove = (e: React.MouseEvent) => {
        e.stopPropagation();
        const update: SceneUpdate = { op: 'remove', id: model.id };
        record(`Removed ${sceneModelLabel(model)}`, [model.id], () => {
            broadcastSceneUpdate(update);
            applyLocalSceneUpdate(update);
        });
    };

    return (
        <div className="flex flex-col select-none">
            <div
                data-testid={`scene-model-row-${model.id}`}
                className={clsx(
                    "flex items-center h-7 px-2 cursor-pointer transition-colors border-l-2",
                    isVisible ? "border-blue-400 bg-blue-50/40" : "border-transparent hover:bg-gray-50"
                )}
                style={{ paddingLeft: '4px' }}
                onClick={() => {
                    setActiveSceneModel(model.id);
                    selectNode(entry ? entry.sceneTree.id : null);
                }}
            >
                <div
                    className="w-4 flex items-center justify-center mr-1"
                    onClick={(e) => { e.stopPropagation(); toggleExpanded(model.id); }}
                >
                    {entry?.sceneTree.children
                        ? expanded
                            ? <ChevronDown size={12} className="text-gray-500" />
                            : <ChevronRight size={12} className="text-gray-500" />
                        : null}
                </div>

                <div className="mr-2 text-gray-500"><Box size={12} /></div>

                <span
                    className={clsx(
                        "text-[10px] font-mono truncate flex-1",
                        isVisible ? "font-bold text-gray-800" : "text-gray-500",
                        !isVisible && "opacity-60 line-through"
                    )}
                >
                    {sceneModelLabel(model)}
                </span>

                {/* SAID IN WORDS, not only drawn. A revision an import superseded goes
                    dark rather than being deleted — it is the version the older cards
                    were raised against, and Compare needs it — and grey with a strike
                    through it was the only thing saying so. To the person who just
                    imported "Rev B" that looked like "Rev A is gone", which is the
                    report batch BQ answers: a row that is still here says it is hidden,
                    and the eye beside it is one click from bringing it back. */}
                {!isVisible && (
                    <span
                        data-testid={`scene-model-hidden-${model.id}`}
                        className="ml-1 shrink-0 px-1 py-px rounded bg-gray-100 font-mono text-[8px] font-bold uppercase tracking-wide text-gray-500"
                    >
                        hidden
                    </span>
                )}

                {!entry && <Loader2 size={10} className="animate-spin text-gray-400 mr-1" />}

                {canChangeModels && revisionsInLine > 1 && (
                    <div
                        title={isComparing ? 'Comparing revisions of this line' : `Compare revisions of ${model.line}`}
                        className={clsx(
                            "w-5 h-5 flex items-center justify-center rounded hover:bg-gray-200 ml-0.5",
                            isComparing ? "text-blue-600" : "text-gray-400 hover:text-gray-700"
                        )}
                        onClick={(e) => { e.stopPropagation(); onCompare(model.line); }}
                    >
                        <GitCompare size={10} />
                    </div>
                )}

                {canChangeModels && (
                    <div
                        title="Remove this model from the room's scene"
                        className="w-5 h-5 flex items-center justify-center rounded hover:bg-red-100 text-gray-400 hover:text-red-600 ml-0.5"
                        onClick={handleRemove}
                    >
                        <Trash2 size={10} />
                    </div>
                )}

                <div
                    title={isVisible
                        ? (canChangeModels ? 'Hide this model for everyone' : (reason ?? 'Hide this model on your screen only'))
                        : 'Show this model again'}
                    data-testid={`scene-model-eye-${model.id}`}
                    className={clsx(
                        "w-5 h-5 flex items-center justify-center rounded hover:bg-gray-200 ml-1",
                        isVisible ? "text-gray-400 hover:text-gray-700" : "text-gray-500 hover:text-black"
                    )}
                    onClick={handleToggleVis}
                >
                    {isVisible ? <Eye size={10} /> : <EyeOff size={10} />}
                </div>
            </div>

            {expanded && entry && (
                <div className="flex flex-col relative">
                    <div className="absolute left-[9px] top-0 bottom-0 w-px bg-gray-200"></div>
                    {(entry.sceneTree.children ?? []).map(child => (
                        <TreeNode key={child.id} node={child} depth={1} />
                    ))}
                </div>
            )}
        </div>
    );
});

/**
 * Pick two revisions of a line and put them side by side.
 *
 * A scene operation, not a local view: it changes shared visibility and shared
 * offsets, so everybody in the room sees the same comparison — which is the only
 * version of "compare" worth having in a meeting where one person is driving.
 */
const ComparePicker: React.FC<{ line: string; onClose: () => void }> = ({ line, onClose }) => {
    // Selected whole and filtered here, not in the selector: a selector that
    // returns a new array on every call is a new snapshot on every call, and
    // useSyncExternalStore re-renders until it finds one that is equal.
    const allModels = useStore(state => state.scene.models);
    const models = useMemo(() => allModels.filter(m => m.line === line), [allModels, line]);
    const sceneEntries = useStore(state => state.sceneEntries);
    const compare = useStore(state => state.compare);
    const setSceneCompare = useStore(state => state.setSceneCompare);
    const applyLocalSceneUpdate = useStore(state => state.applyLocalSceneUpdate);
    const { broadcastSceneUpdate } = usePresence();
    const [olderId, setOlderId] = useState(models[0]?.id ?? '');
    const [newerId, setNewerId] = useState(models[models.length - 1]?.id ?? '');

    const send = (updates: SceneUpdate[]) => {
        // Predicted locally as well as sent, so the two revisions move the moment
        // the button is pressed rather than a round trip later.
        for (const update of updates) {
            broadcastSceneUpdate(update);
            applyLocalSceneUpdate(update);
        }
    };

    const active = compare?.line === line ? compare : null;
    const ready = Boolean(sceneEntries[olderId]) && Boolean(sceneEntries[newerId]);

    const start = () => {
        const older = models.find(m => m.id === olderId);
        const newer = models.find(m => m.id === newerId);
        const olderEntry = sceneEntries[olderId];
        const newerEntry = sceneEntries[newerId];
        if (!older || !newer || !olderEntry || !newerEntry || older.id === newer.id) return;
        // What to put back when the comparison ends. Snapshotted from the shared
        // scene as it is NOW, so leaving Compare restores what the room had
        // rather than what this participant happens to remember.
        const restore = [older, newer].map(m => ({ id: m.id, visible: m.visible, offset: m.offset }));
        const offsets = compareOffsets(
            { offset: older.offset, width: sceneEntryWidth(olderEntry) },
            { offset: newer.offset, width: sceneEntryWidth(newerEntry) },
        );
        send([
            { op: 'setVisible', id: older.id, visible: true },
            { op: 'setVisible', id: newer.id, visible: true },
            { op: 'setOffset', id: older.id, offset: offsets.older },
            { op: 'setOffset', id: newer.id, offset: offsets.newer },
        ]);
        setSceneCompare({ line, olderId: older.id, newerId: newer.id, restore });
    };

    const stop = () => {
        if (!active) return;
        // Restore FIRST, then clear: applyLocalSceneUpdate with a fresh flag
        // would drop the snapshot, and the snapshot is what is being restored.
        active.restore.forEach((item) => {
            const setVisible: SceneUpdate = { op: 'setVisible', id: item.id, visible: item.visible };
            const setOffset: SceneUpdate = { op: 'setOffset', id: item.id, offset: item.offset };
            broadcastSceneUpdate(setVisible);
            applyLocalSceneUpdate(setVisible);
            broadcastSceneUpdate(setOffset);
            applyLocalSceneUpdate(setOffset);
        });
        setSceneCompare(null);
    };

    return (
        <div className="mx-2 my-1 p-2 bg-blue-50 border border-blue-200 rounded text-[9px] text-blue-800">
            <div className="flex items-center justify-between mb-1">
                <span className="font-bold uppercase tracking-wide text-[8px]">Compare {line}</span>
                <button onClick={onClose} className="text-blue-400 hover:text-blue-700"><X size={10} /></button>
            </div>

            {active ? (
                <button
                    onClick={stop}
                    className="w-full px-2 py-1 rounded bg-white border border-blue-300 text-blue-700 font-bold hover:bg-blue-100"
                >
                    Leave comparison
                </button>
            ) : (
                <>
                    <label className="block mb-1">
                        <span className="block text-[8px] uppercase text-blue-500 mb-0.5">Older</span>
                        <select
                            value={olderId}
                            onChange={e => setOlderId(e.target.value)}
                            className="w-full px-1 py-0.5 rounded border border-blue-200 bg-white font-mono"
                        >
                            {models.map(m => <option key={m.id} value={m.id}>Rev {m.revision}</option>)}
                        </select>
                    </label>
                    <label className="block mb-1.5">
                        <span className="block text-[8px] uppercase text-blue-500 mb-0.5">Newer</span>
                        <select
                            value={newerId}
                            onChange={e => setNewerId(e.target.value)}
                            className="w-full px-1 py-0.5 rounded border border-blue-200 bg-white font-mono"
                        >
                            {models.map(m => <option key={m.id} value={m.id}>Rev {m.revision}</option>)}
                        </select>
                    </label>
                    <button
                        onClick={start}
                        disabled={!ready || olderId === newerId}
                        className={clsx(
                            "w-full px-2 py-1 rounded font-bold",
                            ready && olderId !== newerId
                                ? "bg-blue-500 text-white hover:bg-blue-600"
                                : "bg-gray-100 text-gray-400 cursor-not-allowed"
                        )}
                    >
                        {ready ? 'Show side by side' : 'Waiting for the files…'}
                    </button>
                </>
            )}
        </div>
    );
};

/**
 * Who may change the models in this room.
 *
 * Shown to whoever lib/scene/roomScene.scenePermissions says may set it — the
 * meeting host on a deployment with no identities, the review's owners and
 * editors on one with accounts — and enforced by the room server, which asks that
 * same function. Somebody it refuses does not see this control, and if they sent
 * the message anyway they would get a SCENE_REFUSED back. What is here is the
 * honest label for a rule that already applies.
 */
const ModelEditorsControl: React.FC = () => {
    const modelEditors = useStore(state => state.modelEditors);
    const setModelEditors = useStore(state => state.setModelEditors);
    const { remoteParticipantList, localUserId, broadcastSetModelEditors } = usePresence();
    const localName = useStore(state => state.currentUser);
    const [choosing, setChoosing] = useState(false);

    const named: string[] = Array.isArray(modelEditors) ? modelEditors : [];
    const people = [
        { userId: localUserId, name: `${localName} (you)` },
        ...remoteParticipantList.map(p => ({ userId: p.userId, name: p.name })),
    ];

    const choose = (editors: ModelEditors) => {
        // Sent, then applied locally: the server takes this only from somebody
        // scenePermissions says may set it, and relays the whole scene back, so the
        // local step is what makes the button feel like it did something. Outside a
        // room it is all there is.
        broadcastSetModelEditors(editors);
        setModelEditors(editors);
    };

    const togglePerson = (userId: string) => {
        choose(named.includes(userId) ? named.filter(id => id !== userId) : [...named, userId]);
    };

    return (
        <div className="mt-2 pt-2 border-t border-gray-200">
            <div className="flex items-center gap-1 text-[8px] font-bold uppercase tracking-wide text-gray-400 mb-1">
                <Users size={9} />
                <span>Who can change models</span>
            </div>
            <div className="flex gap-1">
                <button
                    onClick={() => choose('host')}
                    title="Only the host can import, hide, move or remove models"
                    className={clsx(
                        "flex-1 px-1 py-1 rounded text-[8px] font-bold flex items-center justify-center gap-0.5 border",
                        modelEditors === 'host' ? "bg-blue-500 text-white border-blue-500" : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"
                    )}
                >
                    <Lock size={8} /> Host only
                </button>
                <button
                    onClick={() => choose('everyone')}
                    title="Anyone in the room can change the models"
                    className={clsx(
                        "flex-1 px-1 py-1 rounded text-[8px] font-bold flex items-center justify-center gap-0.5 border",
                        modelEditors === 'everyone' ? "bg-blue-500 text-white border-blue-500" : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"
                    )}
                >
                    <Globe size={8} /> Everyone
                </button>
                <button
                    onClick={() => setChoosing(c => !c)}
                    title="Choose which people may change the models"
                    className={clsx(
                        "flex-1 px-1 py-1 rounded text-[8px] font-bold flex items-center justify-center gap-0.5 border",
                        Array.isArray(modelEditors) ? "bg-blue-500 text-white border-blue-500" : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"
                    )}
                >
                    <Users size={8} /> Choose…
                </button>
            </div>

            {(choosing || Array.isArray(modelEditors)) && (
                <div className="mt-1 max-h-24 overflow-y-auto custom-scrollbar border border-gray-200 rounded bg-white">
                    {people.map(person => (
                        <label
                            key={person.userId}
                            className="flex items-center gap-1.5 px-1.5 py-1 text-[9px] text-gray-700 hover:bg-gray-50 cursor-pointer"
                        >
                            <input
                                type="checkbox"
                                checked={named.includes(person.userId)}
                                onChange={() => togglePerson(person.userId)}
                                className="accent-blue-500"
                            />
                            <span className="truncate font-mono">{person.name}</span>
                        </label>
                    ))}
                </div>
            )}
        </div>
    );
};

/**
 * The one file the user picked, held between the upload and the answer to
 * "what should this do to the scene".
 */
interface PendingImport {
    fileName: string;
    hash: string;
    /** The stored size in bytes, which is what model_revisions records. */
    size: number;
    parsed: ModelImportResult;
}

/**
 * The design review this scene belongs to, or null.
 *
 * In a room the config arrived from the room server, or was seeded by the
 * curator who walked in with the draft still in memory, and its reviewId IS the
 * room id. On the review setup page it is the draft being edited, where there is
 * no room at all. Null for an ad-hoc session nobody curated: there is no review
 * to store a revision against, and the scene still works exactly as it did
 * before model_revisions existed.
 */
function currentReviewId(): string | null {
    const inRoom = useActiveReviewStore.getState().config?.reviewId;
    if (inRoom) return inRoom;
    return useReviewSetupStore.getState().draft?.reviewId ?? null;
}

type ImportChoice = 'revision' | 'beside' | 'replace';

const SceneTree: React.FC = () => {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const activeModelType = useStore(state => state.activeModelType);
    const isImporting = useStore(state => state.isImporting);
    const setIsImporting = useStore(state => state.setIsImporting);
    const scene = useStore(state => state.scene);
    const sceneEntries = useStore(state => state.sceneEntries);
    const activeSceneModelId = useStore(state => state.activeSceneModelId);
    const applyLocalSceneUpdate = useStore(state => state.applyLocalSceneUpdate);
    const upsertSceneModel = useStore(state => state.upsertSceneModel);
    const setActiveSceneModel = useStore(state => state.setActiveSceneModel);
    const sceneRefusal = useStore(state => state.sceneRefusal);
    const setSceneRefusal = useStore(state => state.setSceneRefusal);
    const importedSceneTree = useStore(state => state.importedSceneTree);
    const bicycleSceneTree = useStore(state => state.bicycleSceneTree);
    const headphonesSceneTree = useStore(state => state.headphonesSceneTree);
    const importSuccess = useStore(state => state.importSuccess);
    const setImportStatus = useStore(state => state.setImportStatus);
    const clearImportStatus = useStore(state => state.clearImportStatus);

    const { broadcastSceneUpdate, localUserId } = usePresence();
    const { canChangeModels, maySetModelEditors, reason: cannotChangeReason } = useScenePermissions();
    const { samples, chooseSample } = useSampleModels();
    const { record } = useSceneEditHistory();

    const [importError, setImportError] = useState<string | null>(null);
    // The slow-CAD advisory for the file being imported, or null. Local state
    // like importError rather than in the store: it belongs to this panel's
    // status strip, and nothing else in the app has a use for it.
    const [importWarning, setImportWarning] = useState<string | null>(null);
    const [pending, setPending] = useState<PendingImport | null>(null);
    const [compareLine, setCompareLine] = useState<string | null>(null);
    // Fraction of the file that has reached the server, or null when nothing is
    // being shared. Kept out of the zustand store: it changes many times a
    // second during an upload and only this panel renders it.
    const [shareProgress, setShareProgress] = useState<number | null>(null);

    // Whether the import was started from "+ Revision" rather than from "Import".
    //
    // Both open the same picker and end at the same chooser — batch BB already put
    // "New revision of …" in it, and this reuses that flow rather than growing a
    // second one. What the intent changes is which answer the chooser marks as the
    // expected one, because a curator who pressed "+ Revision" has already told the
    // room what they meant and should not have to pick it again from three options.
    const [revisionIntent, setRevisionIntent] = useState(false);

    // Whether THIS person has the review's Edit switch on. "+ Revision" is a
    // curation act — it changes the review's model list for everybody — so it
    // belongs to the amber strip's session and not to the meeting.
    const reviewEditing = useStore(state => state.reviewEditing);
    const iAmEditing = reviewEditing !== null && reviewEditing.userId === localUserId;

    const currentTree = getCurrentSceneTree(activeModelType, importedSceneTree, bicycleSceneTree, headphonesSceneTree);
    const objectStates = useStore(state => state.objectStates);
    const toggleExpanded = useStore(state => state.toggleNodeExpanded);
    const toggleSceneModelExpanded = useStore(state => state.toggleSceneModelExpanded);
    const expandedSceneModels = useStore(state => state.expandedSceneModels);

    // The line a new revision would continue: the one the tree is pointing at,
    // or the last model added. Saying which line it is on the button is what
    // makes that choice visible rather than a guess the user has to check.
    const activeLine = useMemo(
        () => scene.models.find(m => m.id === activeSceneModelId)?.line ?? null,
        [scene, activeSceneModelId],
    );

    // Auto-expand ancestors when a node is selected (from 3D view or elsewhere).
    // With several models in the scene the ancestors can include a model's own
    // root, whose expansion lives in expandedSceneModels rather than objectStates.
    const prevSelectedIdRef = useRef<string | null>(null);
    useEffect(() => {
      const selectedId = Object.keys(objectStates).find(id => objectStates[id]?.selected) ?? null;
      if (selectedId && selectedId !== prevSelectedIdRef.current) {
        const rootIdByModel = new Map<string, string>();
        for (const model of scene.models) {
          const entry = sceneEntries[model.id];
          if (entry) rootIdByModel.set(entry.sceneTree.id, model.id);
        }
        const ancestors = findAncestorIds(currentTree, selectedId);
        ancestors.forEach(ancestorId => {
          if (ancestorId === SCENE_ROOT_ID) return;
          const modelId = rootIdByModel.get(ancestorId);
          if (modelId) {
            if (!expandedSceneModels[modelId]) toggleSceneModelExpanded(modelId);
            return;
          }
          const ancestorState = objectStates[ancestorId];
          if (ancestorState && !ancestorState.expanded) {
            toggleExpanded(ancestorId);
          }
        });
      }
      prevSelectedIdRef.current = selectedId;
    }, [objectStates, currentTree, toggleExpanded, scene, sceneEntries, expandedSceneModels, toggleSceneModelExpanded]);

    // Auto-clear success message after 5 seconds
    useEffect(() => {
        if (importSuccess) {
            const timer = setTimeout(() => {
                clearImportStatus();
            }, 5000);
            return () => clearTimeout(timer);
        }
    }, [importSuccess, clearImportStatus]);

    /**
     * Send each operation to the room, then make the same change locally.
     *
     * Both, always. The room server is the truth and will relay the resulting
     * scene back — to this client too — so the local step is a prediction that
     * the echo either confirms or replaces. It is still needed: the review setup
     * page has no room to send to, and even in a room the model should appear on
     * the importer's screen before the round trip finishes.
     */
    const applySceneUpdates = (updates: SceneUpdate[], options?: { fresh?: boolean }) => {
        updates.forEach((update, index) => {
            broadcastSceneUpdate(update);
            applyLocalSceneUpdate(update, index === 0 ? options : undefined);
        });
    };

    const handleImportClick = (asRevision = false) => {
        setRevisionIntent(asRevision);
        fileInputRef.current?.click();
    };

    /**
     * One file, all the way into the scene: validate it, share it, parse it, then
     * place it or ask where it goes.
     *
     * This was the file input's onChange until batch BG split the file out of the
     * event, because the PLM launch's document browser hands over a File it got
     * from Onshape rather than one somebody picked (lib/scene/importHandoff.ts).
     * There is still exactly one copy of the pipeline: the "already in the scene"
     * guard, the beside / replace / revision choice and the model_revisions row are
     * the parts of an import that are easy to get subtly wrong, and a second
     * pipeline for launched models would be a second place to get them wrong.
     *
     * The picker's own value is not reset here — that belongs to the caller that
     * has one.
     */
    const importPickedFile = async (file: File) => {
        // Validate file
        const error = validateModelFile(file);
        if (error) {
            setImportError(error);
            setImportWarning(null);
            return;
        }

        setIsImporting(true);
        setImportError(null);
        // Set before the upload so it is on screen for the whole import, and
        // cleared by the same call when the file is a small one or a mesh. It
        // advises, it does not block: tessellating a 150 MB STEP can take
        // minutes, and the person who picked it is the one who decides whether
        // to wait that out or go and re-export.
        setImportWarning(largeCadWarningFor(file));
        setShareProgress(null);

        // Stored on the server FIRST, then parsed. Two steps on purpose, and the
        // order is the one batch BA chose: the hash is what the scene holds, so
        // a file this server cannot store is a file the room can never see, and
        // saying so before parsing 200 MB is kinder than saying it after.
        //
        // There is no sharing cap any more. The old 50 MB one existed because the
        // file travelled through the room socket as base64; the ceiling now is the
        // 200 MB the picker enforces and the api enforces again.
        let stored;
        try {
            setShareProgress(0);
            stored = await uploadModelFile(file, setShareProgress);
        } catch (error) {
            console.error('Model sharing error:', error);
            setImportError(error instanceof Error ? error.message : MODEL_UPLOAD_NETWORK_MESSAGE);
            setShareProgress(null);
            setIsImporting(false);
            return;
        } finally {
            setShareProgress(null);
        }

        const id = sceneModelId(stored.hash);
        const already = useStore.getState().scene.models.find(m => m.id === id);
        if (already) {
            // The id comes from the hash, so the same file twice is the same
            // model. Saying so beats an add that silently does nothing.
            setImportError(`That file is already in the scene as ${sceneModelLabel(already)}.`);
            setIsImporting(false);
            return;
        }

        let parsed: ModelImportResult;
        try {
            // Parsed here as well as by the loader, and not wasted: the width of
            // the parsed model is what "put it next to the others" measures
            // against, and handing the result to the store saves the loader
            // parsing the same bytes a second time.
            parsed = await parseModelFile(file, { treePrefix: sceneModelPrefix(stored.hash) });
        } catch (error) {
            console.error('Model import error:', error);
            setImportError(error instanceof Error ? error.message : 'Failed to import model file');
            setIsImporting(false);
            return;
        }

        setIsImporting(false);
        // The wait it warned about is over. Kept on the failure paths above,
        // where it is the likeliest explanation of the error beside it.
        setImportWarning(null);

        if (useStore.getState().scene.models.length === 0) {
            // Nothing in the scene, so there is nothing to ask about: it goes in
            // at the origin, which is the only place there is.
            finishImport({ fileName: stored.fileName, hash: stored.hash, size: stored.size, parsed }, 'beside');
            return;
        }
        setPending({ fileName: stored.fileName, hash: stored.hash, size: stored.size, parsed });
    };

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            await importPickedFile(file);
        } finally {
            // Whatever happened — refused, already in the scene, shared and placed —
            // the picker is left empty again, so choosing the same file twice in a
            // row still fires a change.
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    };

    // The PLM launch's document browser leaves its file in a module slot rather
    // than passing it down: it is an overlay in the room's Edit panel and this is a
    // panel in the room's left column, so there is no prop between them and no
    // second pipeline to write (lib/scene/importHandoff.ts).
    //
    // Read through a ref and claimed once for the length of the mount, the way
    // components/UI/Interface.tsx reads the sender of its own ?edit=1 request: the
    // function is a fresh closure on every render, so a claim that listed it as a
    // dependency would clear and re-take the slot on every render of the tree.
    const importPickedFileRef = useRef(importPickedFile);
    useEffect(() => {
        importPickedFileRef.current = importPickedFile;
    });
    useEffect(() => claimSceneImports((file) => { void importPickedFileRef.current(file); }), []);

    // The prompt an empty room shows in the middle of the canvas has an "Import a
    // model" button on it, and it has to open THIS picker: the file input, the
    // pipeline behind it and the "+ Revision" intent all live here, and a second
    // picker would be a second place to get them wrong (batch BI). Same module
    // slot, same reason, and read through a ref for the same reason again.
    const openImportPickerRef = useRef(() => handleImportClick(false));
    useEffect(() => {
        openImportPickerRef.current = () => handleImportClick(false);
    });
    useEffect(() => claimImportPicker(() => openImportPickerRef.current()), []);

    /**
     * Put an uploaded, parsed file into the scene, the way the user just asked.
     *
     * Three answers to one question, and they differ in what happens to what was
     * already there — which is the thing the plan was about. A revision hides
     * the version it supersedes, because a review continues on the new one; a
     * different model goes beside what is there, because both are under
     * discussion; a replacement starts again, and takes the meeting's content
     * with it the way importing always did.
     */
    const finishImport = (imported: PendingImport, choice: ImportChoice, revisionLine: string | null = null) => {
        const models = useStore.getState().scene.models;
        // Read fresh, not from the render closure: this runs after an upload and
        // a parse, during which the loader may have measured models that were
        // still downloading when the file was picked.
        const entries = useStore.getState().sceneEntries;
        const width = imported.parsed.size.x * imported.parsed.baseScale;
        const line = choice === 'revision' && revisionLine
            ? revisionLine
            : lineFromFileName(imported.fileName);
        const previous = choice === 'revision' && revisionLine ? latestOfLine(models, revisionLine) : null;

        // A model still downloading has no measured width. Every import is
        // normalised to about two scene units across, so the new file's own width
        // is the honest estimate for one that has not been measured yet.
        const extents: SceneExtent[] = models.map(model => {
            const entry = entries[model.id];
            return { offset: model.offset, width: entry ? sceneEntryWidth(entry) : width };
        });

        const offset: [number, number, number] =
            choice === 'beside'
                ? nextToOffset(extents, width)
                : choice === 'revision' && previous
                  ? previous.offset
                  : [0, 0, 0];

        const model: SceneModel = {
            id: sceneModelId(imported.hash),
            hash: imported.hash,
            fileName: imported.fileName,
            line,
            revision: choice === 'revision' ? nextRevisionFor(models, line) : FIRST_REVISION,
            visible: true,
            offset,
        };

        const updates: SceneUpdate[] = [];
        if (choice === 'revision' && previous) {
            // The revision it supersedes goes dark rather than being deleted: it
            // is the version the older comments and pins were raised against, and
            // Compare needs it to still be there.
            updates.push({ op: 'setVisible', id: previous.id, visible: false });
        }
        if (choice === 'replace') {
            for (const existing of models) updates.push({ op: 'remove', id: existing.id });
        }
        updates.push({ op: 'add', model });

        // ONE step for the whole import, whatever it did to what was already there:
        // undoing "added Rev B" has to bring Rev A back into the light with it, and
        // undoing a replacement has to bring back everything it replaced. Every id the
        // batch touches is named here, including the ones it removes — after the fact
        // there is no record left in the scene to find them by.
        const touched = [
            model.id,
            ...(previous ? [previous.id] : []),
            ...(choice === 'replace' ? models.map((existing) => existing.id) : []),
        ];
        record(
            choice === 'replace'
                ? `Replaced the scene with ${sceneModelLabel(model)}`
                : `Added ${sceneModelLabel(model)}`,
            [...new Set(touched)],
            () => applySceneUpdates(updates, choice === 'replace' ? { fresh: true } : undefined),
        );
        // After the scene, not before: adopting a scene drops the parsed geometry
        // of any model it no longer holds, so an entry added first would be thrown
        // away by the very change that asks for it.
        upsertSceneModel(sceneModelEntry(model, imported.parsed));
        setActiveSceneModel(model.id);
        setPending(null);
        setImportStatus(
            null,
            `Imported "${imported.fileName}" as ${sceneModelLabel(model)} (${countParts(imported.parsed.sceneTree)} parts)`,
        );

        // The review's own history, written beside the scene change rather than
        // instead of it (docs/plan/14 batch BC). The scene is what the room is
        // looking at and lives in the room server; this row is what the design
        // review has shown, and it is what the tracker means by "raised on Rev A"
        // a year from now.
        //
        // Fire and forget, and a failure is only logged: the model is on screen
        // for everybody and works, so a bookkeeping write that did not land is
        // not a reason to take it back. The letter comes from the scene, which is
        // the same list the picker above showed its "Becomes Rev …" from, so the
        // two cannot disagree — and if another browser got there first, the
        // table's unique (review_id, line, revision) refuses this row rather than
        // letting two files both be Rev B.
        const reviewId = currentReviewId();
        if (reviewId) {
            void recordModelRevision({
                reviewId,
                line: model.line,
                revision: model.revision,
                hash: model.hash,
                fileName: model.fileName,
                size: imported.size,
            });
        }
    };

    const activeEntry = activeSceneModelId ? sceneEntries[activeSceneModelId] : undefined;
    const activeModel = scene.models.find(m => m.id === activeSceneModelId);

    // Get display name for current model
    const getModelFileName = () => {
        if (activeEntry) return activeEntry.fileName;
        if (activeModelType === 'bicycle') return 'urban_commuter_bicycle.step';
        if (activeModelType === 'headphones') return 'headphones.glb';
        return 'synth_assembly.step';
    };

    return (
        <div className="w-64 bg-white/90 backdrop-blur-md border border-gray-200 rounded-lg shadow-sm flex flex-col overflow-hidden pointer-events-auto mt-2">
            {/* Header with Import Button */}
            <div className="bg-gray-50 border-b border-gray-100 px-3 py-2">
                <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] font-bold uppercase text-gray-500 tracking-wide">Model Tree</span>
                    <div className="flex items-center gap-1">
                        {scene.models.length > 0 && (
                            <span className="text-[8px] bg-blue-100 text-blue-600 px-1.5 py-0.5 rounded font-bold">
                                {scene.models.length} {scene.models.length === 1 ? 'model' : 'models'}
                            </span>
                        )}
                        {(activeModelType === 'bicycle' || activeModelType === 'imported') && (
                            <span className="text-[8px] bg-blue-100 text-blue-600 px-1.5 py-0.5 rounded font-bold">
                                3D
                            </span>
                        )}
                        <Layers size={12} className="text-gray-400" />
                    </div>
                </div>

                {/* Import Model Button */}
                <button
                    onClick={() => handleImportClick()}
                    disabled={isImporting || !canChangeModels}
                    title={cannotChangeReason ?? 'Import a 3D model into this room'}
                    className={clsx(
                        "w-full px-3 py-2 rounded text-[10px] font-bold flex items-center justify-center gap-2 transition-all",
                        isImporting || !canChangeModels
                            ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                            : "bg-blue-500 text-white hover:bg-blue-600 shadow-sm"
                    )}
                >
                    {isImporting ? (
                        <>
                            <Loader2 size={12} className="animate-spin" />
                            Importing Model...
                        </>
                    ) : (
                        <>
                            <Upload size={12} />
                            {canChangeModels ? 'Import 3D Model' : 'Import locked'}
                        </>
                    )}
                </button>

                {/* + Revision — only while this person is editing the review, and
                    only when there is a line to continue. Same picker and same
                    chooser as Import; see revisionIntent. */}
                {iAmEditing && canChangeModels && scene.models.length > 0 && (
                    <button
                        onClick={() => handleImportClick(true)}
                        disabled={isImporting}
                        title={activeLine
                            ? `Import a new revision of ${activeLine}`
                            : 'Import a file, then choose which line it revises'}
                        className={clsx(
                            "mt-1 w-full px-3 py-1.5 rounded text-[10px] font-bold flex items-center justify-center gap-1.5 transition-all",
                            isImporting
                                ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                                : "bg-amber-400 text-black hover:bg-amber-300"
                        )}
                    >
                        <Upload size={11} />
                        + Revision{activeLine ? ` of ${activeLine}` : ''}
                    </button>
                )}

                {/* Samples — the three models that ship with the app, which batch
                    BI stopped being the default and became a choice. Offered only
                    while the scene holds nothing of its own: activeModelTypeFor
                    reads 'imported' whenever the list is non-empty, so a sample
                    chosen underneath an import would be recorded and stay
                    invisible, and a button that appears to do nothing is worse
                    than no button. */}
                {scene.models.length === 0 && (
                    <div className="mt-2">
                        <div className="flex items-center gap-1 text-[8px] font-bold uppercase tracking-wide text-gray-400 mb-1">
                            <Sparkles size={9} />
                            <span>or try a sample</span>
                        </div>
                        <div className="flex gap-1">
                            {samples.map(sample => (
                                <button
                                    key={sample.builtIn}
                                    onClick={() => chooseSample(sample.builtIn)}
                                    disabled={isImporting || !canChangeModels}
                                    title={cannotChangeReason ?? `Put the ${sample.label} sample in the room`}
                                    className={clsx(
                                        "flex-1 min-w-0 px-1 py-1 rounded text-[8px] font-bold border truncate transition-colors",
                                        isImporting || !canChangeModels
                                            ? "bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed"
                                            : activeModelType === sample.builtIn
                                                ? "bg-blue-500 text-white border-blue-500"
                                                : "bg-white text-gray-600 border-gray-200 hover:bg-blue-50 hover:border-blue-300"
                                    )}
                                >
                                    {sample.label}
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                <input
                    ref={fileInputRef}
                    type="file"
                    accept={MODEL_FILE_ACCEPT}
                    onChange={handleFileChange}
                    className="hidden"
                />

                {/* One question, inline. A browser dialog would have been less
                    code and much worse: it cannot say what each answer does to
                    the models already on screen, which is the whole decision. */}
                {pending && (
                    <div className="mt-2 p-2 bg-white border border-blue-300 rounded text-[9px] text-gray-700">
                        <div className="flex items-center justify-between mb-1.5">
                            <span className="font-bold uppercase tracking-wide text-[8px] text-gray-500">
                                Add “{pending.fileName}”
                            </span>
                            <button onClick={() => setPending(null)} className="text-gray-400 hover:text-gray-700">
                                <X size={10} />
                            </button>
                        </div>
                        <div className="flex flex-col gap-1">
                            {/* FIRST, AND THE ONLY BLACK ONE.
                                Batch BQ. The three answers used to be ordered revision ·
                                beside · replace, and "New revision of Bracket — becomes Rev B
                                and hides the one before it" was the one at the top in the
                                boldest type. Read as an instruction rather than as an option,
                                it says "the old model goes", and the user's report was exactly
                                that: "importing one 3d model deletes the last". Nothing was
                                deleted — a revision is kept and can be shown again — but the
                                first thing on offer was the one that changes what is on
                                screen, and the one that changes nothing about the models
                                already there was second. So the safe answer leads, and the
                                one that removes things is last and in red. */}
                            <button
                                onClick={() => finishImport(pending, 'beside')}
                                data-testid="import-choice-beside"
                                className="px-2 py-1.5 rounded border border-black bg-black hover:bg-gray-800 text-left"
                            >
                                <span className="block font-bold text-[9px] text-white">Add next to it</span>
                                <span className="block text-[8px] text-gray-300">
                                    Both models stay on screen.
                                </span>
                            </button>
                            {revisionTargets(scene.models, pending.fileName, activeLine).map(line => {
                                // Marked, not chosen for them: the picker cannot know
                                // whether the file really is the next revision of the
                                // line the tree was pointing at, and silently applying
                                // "hides the one before it" to the wrong line is the
                                // kind of undo nobody expects to need.
                                const suggested = revisionIntent && line === activeLine;
                                const superseded = latestOfLine(scene.models, line)?.revision ?? null;
                                return (
                                <button
                                    key={line}
                                    onClick={() => finishImport(pending, 'revision', line)}
                                    data-testid={`import-choice-revision-${line}`}
                                    className={clsx(
                                        "px-2 py-1 rounded border text-left",
                                        suggested
                                            ? "border-amber-400 bg-amber-50 ring-1 ring-amber-300"
                                            : "border-gray-200 hover:bg-blue-50 hover:border-blue-300"
                                    )}
                                >
                                    <span className="block font-bold text-[9px] text-gray-800">
                                        New revision of {line}
                                        {suggested && (
                                            <span className="ml-1 text-[8px] font-bold uppercase tracking-wide text-amber-600">
                                                from + Revision
                                            </span>
                                        )}
                                    </span>
                                    {/* Named, and said to be KEPT. "Hides the one before it"
                                        was true and still read as a deletion, so the sentence
                                        now names the revision going dark and says where it
                                        comes back from. */}
                                    <span className="block text-[8px] text-gray-500">
                                        {superseded
                                            ? `Shown instead of Rev ${superseded}. Rev ${superseded} is kept; show it again from the tree.`
                                            : 'Shown instead of the one before it, which is kept; show it again from the tree.'}
                                    </span>
                                </button>
                                );
                            })}
                            <button
                                onClick={() => finishImport(pending, 'replace')}
                                data-testid="import-choice-replace"
                                className="px-2 py-1 rounded border border-gray-200 hover:bg-red-50 hover:border-red-300 text-left"
                            >
                                <span className="block font-bold text-[9px] text-red-700">Replace everything</span>
                                <span className="block text-[8px] text-gray-500">
                                    Removes all models from the scene and clears this meeting’s comments, chat and cards.
                                </span>
                            </button>
                        </div>
                    </div>
                )}

                {/* Current Model Info. Hidden in an empty room rather than
                    answering with a file name: the fallback below is
                    'synth_assembly.step', and naming a file nobody put there is
                    the same lie as naming a product (batch BI). */}
                {activeModelType !== 'none' && (
                    <div className="mt-2 text-[9px] text-gray-400 flex items-center gap-1">
                        <FileBox size={10} />
                        <span className="truncate">{getModelFileName()}</span>
                    </div>
                )}

                {activeEntry && activeModel && (
                    <div className="mt-2 text-[9px] text-gray-500">
                        <div className="flex items-center justify-between">
                            <span className="font-semibold uppercase tracking-wide text-[8px] text-gray-400">
                                Scale · {sceneModelLabel(activeModel)}
                            </span>
                            <span className="text-[9px] text-gray-600 font-mono">{activeEntry.scale.toFixed(2)}x</span>
                        </div>
                        <input
                            type="range"
                            min="0.1"
                            max="10"
                            step="0.05"
                            value={activeEntry.scale}
                            onChange={e => useStore.getState().setSceneModelScale(activeEntry.id, parseFloat(e.target.value))}
                            className="w-full accent-blue-500"
                        />
                    </div>
                )}

                {/* Import Status Messages */}
                {shareProgress !== null && (
                    <div className="mt-2 p-2 bg-blue-50 border border-blue-200 rounded text-[10px] text-blue-700">
                        <div className="flex items-center gap-2">
                            <Loader2 size={12} className="animate-spin text-blue-500 shrink-0" />
                            <span className="flex-1">
                                Sharing with the room… {Math.round(shareProgress * 100)}%
                            </span>
                        </div>
                        <div className="mt-1.5 h-1 bg-blue-100 rounded overflow-hidden">
                            <div
                                className="h-full bg-blue-500 transition-all duration-150"
                                style={{ width: `${Math.round(shareProgress * 100)}%` }}
                            />
                        </div>
                    </div>
                )}

                {/* Amber, not red: nothing has gone wrong, the import is still
                    running and this is the reason it is taking a while. */}
                {importWarning && (
                    <div className="mt-2 p-2 bg-amber-50 border border-amber-200 rounded text-[10px] text-amber-800 flex items-start gap-2 animate-in fade-in slide-in-from-top-2">
                        <AlertTriangle size={14} className="text-amber-500 shrink-0 mt-0.5" />
                        <div className="flex-1">{importWarning}</div>
                        <button
                            onClick={() => setImportWarning(null)}
                            className="text-amber-400 hover:text-amber-600"
                        >
                            <X size={12} />
                        </button>
                    </div>
                )}

                {importSuccess && (
                    <div className="mt-2 p-2 bg-green-50 border border-green-200 rounded text-[10px] text-green-700 flex items-start gap-2 animate-in fade-in slide-in-from-top-2">
                        <CheckCircle2 size={14} className="text-green-500 shrink-0 mt-0.5" />
                        <div className="flex-1">{importSuccess}</div>
                        <button
                            onClick={clearImportStatus}
                            className="text-green-400 hover:text-green-600"
                        >
                            <X size={12} />
                        </button>
                    </div>
                )}

                {(importError || sceneRefusal) && (
                    <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded text-[10px] text-red-700 flex items-start gap-2 animate-in fade-in slide-in-from-top-2">
                        <AlertCircle size={14} className="text-red-500 shrink-0 mt-0.5" />
                        <div className="flex-1">{importError ?? sceneRefusal}</div>
                        <button
                            onClick={() => { setImportError(null); setSceneRefusal(null); }}
                            className="text-red-400 hover:text-red-600"
                        >
                            <X size={12} />
                        </button>
                    </div>
                )}

                {maySetModelEditors && <ModelEditorsControl />}
            </div>

            {/* Tree View */}
            <div className="overflow-y-auto max-h-[35vh] py-1 custom-scrollbar">
                {scene.models.length > 0 ? (
                    scene.models.map(model => (
                        <SceneModelRow key={model.id} model={model} onCompare={setCompareLine} />
                    ))
                ) : activeModelType === 'none' ? (
                    // EMPTY_SCENE_TREE is a childless leaf, and TreeNode renders a
                    // leaf as a row with an eye on it — so an empty room would list
                    // one part called "No model" that hides nothing. Say it in
                    // words instead; the canvas prompt is the one with the buttons.
                    <div className="px-3 py-4 text-center text-[9px] text-gray-400">
                        No model yet
                    </div>
                ) : (
                    <TreeNode node={currentTree} depth={0} />
                )}
                {compareLine && <ComparePicker line={compareLine} onClose={() => setCompareLine(null)} />}
            </div>
        </div>
    );
};

export default SceneTree;

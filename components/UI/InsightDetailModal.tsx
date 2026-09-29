import React from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../store';
import {
    AlertTriangle, CheckCircle2, Lightbulb, X, Calendar, User, Flag, Activity, Box,
    Scale, BrainCircuit
} from 'lucide-react';
import { clsx } from 'clsx';
import { InsightCard, InsightDetails } from '../../types';
import AssigneeComboBox from './AssigneeComboBox';

const InsightDetailModal: React.FC<{
    card: InsightCard,
    onClose: () => void,
    agentColor?: string,
    /**
     * Whether this person may change the card, i.e. `can('editCard')` from
     * lib/reviews/roles.ts. Defaults to true so the three callers that are not
     * the room's Capture panel — the boardroom, the manager workspace and the
     * meeting summary — keep the form they have always had. A guest in a review
     * that has accounts gets the same card to READ with every field disabled:
     * "everyone can meet, point and comment; everyone except guests can add and
     * edit cards" is a rule about editing, not about looking.
     */
    canEdit?: boolean
}> = ({ card, onClose, canEdit }) => {
    const requirements = useStore(state => state.requirements);
    const updateInsight = useStore(state => state.updateInsight);
    
    const { details, affectedRequirementIds, kbRecommendations } = card;

    // Helper to update fields in the store
    const handleUpdate = <K extends keyof InsightCard>(field: K, value: InsightCard[K]) => {
        updateInsight(card.id, { [field]: value } as Partial<InsightCard>);
    };

    const handleDetailUpdate = (field: string, value: unknown) => {
        updateInsight(card.id, {
            details: {
                ...card.details,
                [field]: value,
            } as unknown as InsightDetails,
        });
    };
    
    // Rendered into <body>, not where it is mounted. `position: fixed` is
    // relative to the nearest ancestor with a transform, filter or
    // backdrop-filter, and every panel that opens this modal (the insights
    // sidebar, the manager workspace, the boardroom) has one — so the modal
    // was trapped inside the ~320px panel instead of covering the viewport.
    return createPortal(
        <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 animate-in fade-in duration-200 pointer-events-auto"
            onClick={(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div className="bg-white w-full max-w-lg rounded-lg shadow-2xl border border-gray-200 overflow-hidden flex flex-col max-h-[90vh] animate-in zoom-in-95 duration-200">
                
                {/* Modal Header */}
                <div className="p-4 border-b border-gray-100 flex justify-between items-start bg-gray-50 shrink-0">
                    <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2">
                            {card.type === 'RISK' && <AlertTriangle size={16} className="text-red-500"/>}
                            {card.type === 'ACTION' && <CheckCircle2 size={16} className="text-blue-500"/>}
                            {card.type === 'RATIONALE' && <Lightbulb size={16} className="text-amber-500"/>}
                            <h2 className="text-sm font-bold uppercase tracking-wide text-gray-700">
                                {card.type === 'RISK' ? 'Risk Assessment Form' : 
                                 card.type === 'ACTION' ? 'Task Assignment Record' : 
                                 'Design Decision Record'}
                            </h2>
                        </div>
                        <div className="text-xs text-gray-400 font-mono">ID: {card.id.toUpperCase()}</div>
                    </div>
                    <button onClick={onClose} className="text-gray-400 hover:text-gray-800 transition-colors p-1">
                        <X size={20} />
                    </button>
                </div>

                {/* Modal Body - Scrollable Form.
                    A <fieldset> rather than a <div> purely for `disabled`: one
                    attribute then makes every control in the form read-only,
                    instead of threading a flag through fourteen inputs. The
                    header's Close and the footer's Done stay outside it, so a
                    person who may not edit can still get out. */}
                <fieldset
                    disabled={canEdit === false}
                    className="p-6 overflow-y-auto flex-1 flex flex-col gap-6 custom-scrollbar min-w-0 border-0 m-0"
                >
                    
                    {/* Title Field */}
                    <div className="flex flex-col gap-1">
                        <label className="text-[10px] font-bold text-gray-400 uppercase">Subject</label>
                        <input 
                            type="text" 
                            value={card.title} 
                            onChange={(e) => handleUpdate('title', e.target.value)}
                            className="text-sm font-bold text-gray-800 border-b border-gray-200 focus:border-black outline-none py-1 w-full bg-transparent focus:bg-gray-50 transition-colors"
                        />
                    </div>

                    {/* LINKED COMPONENT FIELD */}
                    <div className="flex flex-col gap-1">
                        <label className="flex items-center gap-1 text-[10px] font-bold text-gray-400 uppercase">
                            <Box size={10}/> Linked Component
                        </label>
                        <div className="flex items-center gap-2 bg-gray-50 border border-gray-200 rounded px-2 py-1.5">
                            <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
                            <input 
                                type="text" 
                                value={details.componentReference ?? ''}
                                placeholder="No component linked"
                                onChange={(e) => handleDetailUpdate('componentReference', e.target.value)}
                                className="text-xs font-mono font-bold text-gray-700 bg-transparent outline-none w-full"
                            />
                        </div>
                    </div>

                    {/* Core Context */}
                    <div className="flex flex-col gap-1">
                        <label className="text-[10px] font-bold text-gray-400 uppercase">Description / Context</label>
                        <textarea 
                            value={card.description}
                            onChange={(e) => handleUpdate('description', e.target.value)}
                            rows={3}
                            className="w-full text-sm text-gray-700 bg-gray-50 p-3 rounded border border-gray-200 focus:border-gray-400 outline-none resize-y"
                        />
                    </div>

                    {/* REQUIREMENTS IMPACT ANALYSIS */}
                    {affectedRequirementIds && affectedRequirementIds.length > 0 && requirements.length > 0 && (
                        <div className="bg-orange-50 border border-orange-100 rounded p-3 flex flex-col gap-2">
                            <div className="flex items-center gap-2 text-orange-800 font-bold text-xs uppercase">
                                <Scale size={12} /> Requirements Impact
                            </div>
                            <div className="flex flex-col gap-2">
                                {affectedRequirementIds.map(reqId => {
                                    const req = requirements.find(r => r.id === reqId);
                                    if (!req) return null;
                                    return (
                                        <div key={reqId} className="bg-white border border-orange-200 rounded p-2 text-xs text-gray-700">
                                            <span className="font-mono font-bold text-orange-600 mr-2">{req.code}</span>
                                            {req.description}
                                        </div>
                                    )
                                })}
                            </div>
                        </div>
                    )}

                    {/* AI RECOMMENDATIONS */}
                    {kbRecommendations && kbRecommendations.length > 0 && (
                         <div className="bg-purple-50 border border-purple-100 rounded p-3 flex flex-col gap-2">
                            <div className="flex items-center gap-2 text-purple-800 font-bold text-xs uppercase">
                                <BrainCircuit size={12} /> AI Historical Suggestion
                            </div>
                             {kbRecommendations.map((rec, i) => (
                                 <div key={i} className="text-xs text-purple-900 italic pl-2 border-l-2 border-purple-300">
                                     "{rec}"
                                 </div>
                             ))}
                        </div>
                    )}

                    {/* Meta Grid */}
                    <div className="grid grid-cols-2 gap-4">
                        <div className="flex flex-col gap-1">
                            <label className="flex items-center gap-1 text-[10px] font-bold text-gray-400 uppercase">
                                <Flag size={10}/> Priority
                            </label>
                            <select 
                                value={details.priority}
                                onChange={(e) => handleDetailUpdate('priority', e.target.value)}
                                className={clsx(
                                    "text-xs font-bold px-2 py-1.5 rounded border outline-none appearance-none cursor-pointer",
                                    "focus:ring-1 focus:ring-black/10",
                                    details.priority === 'Critical' ? "bg-red-50 text-red-700 border-red-200" :
                                    details.priority === 'High' ? "bg-orange-50 text-orange-700 border-orange-200" :
                                    "bg-white text-gray-700 border-gray-200"
                                )}
                            >
                                <option>Critical</option>
                                <option>High</option>
                                <option>Medium</option>
                                <option>Low</option>
                            </select>
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="flex items-center gap-1 text-[10px] font-bold text-gray-400 uppercase">
                                <Activity size={10}/> Status
                            </label>
                            <select 
                                value={details.status}
                                onChange={(e) => handleDetailUpdate('status', e.target.value)}
                                className="text-xs font-mono text-gray-700 bg-white border border-gray-200 px-2 py-1.5 rounded w-fit outline-none focus:border-gray-400 cursor-pointer"
                            >
                                <option>Open</option>
                                <option>In Review</option>
                                <option>Approved</option>
                                <option>Rejected</option>
                            </select>
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="flex items-center gap-1 text-[10px] font-bold text-gray-400 uppercase">
                                <User size={10}/> Assignee
                            </label>
                            <AssigneeComboBox
                                value={details.assignee || ''}
                                onChange={(v) => handleDetailUpdate('assignee', v || undefined)}
                            />
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="flex items-center gap-1 text-[10px] font-bold text-gray-400 uppercase">
                                <Calendar size={10}/> Due Date
                            </label>
                            <input 
                                type="date" 
                                value={details.dueDate}
                                onChange={(e) => handleDetailUpdate('dueDate', e.target.value)}
                                className="text-xs text-gray-800 font-medium border-b border-gray-200 focus:border-black outline-none py-1 bg-transparent cursor-pointer"
                            />
                        </div>
                    </div>

                    {/* Specific Fields */}
                    {card.type === 'RISK' && (
                        <div className="flex flex-col gap-4 border-t border-gray-100 pt-4">
                            <div className="flex flex-col gap-1">
                                <label className="text-[10px] font-bold text-gray-400 uppercase">Potential Impact</label>
                                <textarea 
                                    value={details.impact}
                                    onChange={(e) => handleDetailUpdate('impact', e.target.value)}
                                    rows={2}
                                    className="text-xs text-gray-700 bg-red-50/50 p-2 rounded border border-red-100 focus:border-red-300 outline-none w-full resize-none"
                                />
                            </div>
                            <div className="flex flex-col gap-1">
                                <label className="text-[10px] font-bold text-gray-400 uppercase">Recommended Mitigation</label>
                                <textarea
                                    value={details.mitigationStrategy}
                                    onChange={(e) => handleDetailUpdate('mitigationStrategy', e.target.value)}
                                    rows={2}
                                    className="text-xs text-gray-700 bg-green-50/50 p-2 rounded border border-green-100 focus:border-green-300 outline-none w-full resize-none"
                                />
                            </div>
                        </div>
                    )}

                    {card.type === 'RATIONALE' && (
                        <div className="flex flex-col gap-4 border-t border-gray-100 pt-4">
                            <div className="flex flex-col gap-1">
                                <label className="text-[10px] font-bold text-gray-400 uppercase">Design Driver</label>
                                <input 
                                    type="text"
                                    value={details.designDriver}
                                    onChange={(e) => handleDetailUpdate('designDriver', e.target.value)}
                                    className="text-xs text-gray-700 bg-blue-50/50 p-2 rounded border border-blue-100 focus:border-blue-300 outline-none w-full"
                                />
                            </div>
                            <div className="flex flex-col gap-1">
                                <label className="text-[10px] font-bold text-gray-400 uppercase">Trade-off Analysis</label>
                                <textarea
                                    value={details.tradeoffAnalysis}
                                    onChange={(e) => handleDetailUpdate('tradeoffAnalysis', e.target.value)}
                                    rows={2}
                                    className="text-xs text-gray-700 bg-white p-2 rounded border border-gray-200 focus:border-gray-400 outline-none w-full resize-y"
                                />
                            </div>
                        </div>
                    )}

                     {card.type === 'ACTION' && (
                        <div className="flex flex-col gap-4 border-t border-gray-100 pt-4">
                            <div className="flex flex-col gap-1">
                                <label className="text-[10px] font-bold text-gray-400 uppercase">Owning Department</label>
                                <input 
                                    type="text"
                                    value={details.department}
                                    onChange={(e) => handleDetailUpdate('department', e.target.value)}
                                    className="text-xs text-gray-700 bg-gray-50 p-2 rounded border border-gray-200 focus:border-black outline-none w-full"
                                />
                            </div>
                        </div>
                    )}

                </fieldset>

                {/* Footer */}
                <div className="p-3 border-t border-gray-100 bg-gray-50 flex justify-end gap-2 shrink-0">
                    <button className="px-3 py-1.5 bg-white border border-gray-300 rounded shadow-sm text-xs font-medium text-gray-700 hover:bg-gray-50 transition-colors">
                        Export PDF
                    </button>
                    <button onClick={onClose} className="px-3 py-1.5 bg-black text-white rounded shadow-sm text-xs font-medium hover:bg-gray-800 transition-colors">
                        Done
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
};

export default InsightDetailModal;
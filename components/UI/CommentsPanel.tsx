import React, { useState, useRef, useEffect } from 'react';
import { useStore } from '../../store';
import { usePresence } from '../../lib/PresenceContext';
import { useActiveReviewStore } from '../../lib/activeReviewStore';
import {
    MessageSquare, Pencil, Plus, X, Send, AtSign,
    CheckCircle2, Trash2, MoreVertical, Link2,
    Maximize2, Minimize2
} from 'lucide-react';
import { clsx } from 'clsx';
import { SpatialComment } from '../../types';

// Comment Input Form
const CommentInputForm: React.FC<{
    onSubmit: (content: string, assignees: string[]) => void;
    onCancel: () => void;
    attachedTo: string;
    allowEmpty?: boolean;
    placeholder?: string;
}> = ({ onSubmit, onCancel, attachedTo, allowEmpty = false, placeholder }) => {
    const [content, setContent] = useState('');
    const [showMentions, setShowMentions] = useState(false);
    const [mentionSearch, setMentionSearch] = useState('');
    const inputRef = useRef<HTMLTextAreaElement>(null);

    const participants = ['Alex Chen', 'Sarah J.', 'Marcus T.', 'Design Team', 'Engineering'];

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const value = e.target.value;
        setContent(value);

        // Check for @ trigger
        const lastAtIndex = value.lastIndexOf('@');
        if (lastAtIndex !== -1 && lastAtIndex === value.length - 1) {
            setShowMentions(true);
            setMentionSearch('');
        } else if (lastAtIndex !== -1) {
            const afterAt = value.slice(lastAtIndex + 1);
            if (!afterAt.includes(' ')) {
                setShowMentions(true);
                setMentionSearch(afterAt);
            } else {
                setShowMentions(false);
            }
        } else {
            setShowMentions(false);
        }
    };

    const insertMention = (name: string) => {
        const lastAtIndex = content.lastIndexOf('@');
        const newContent = content.slice(0, lastAtIndex) + '@' + name + ' ';
        setContent(newContent);
        setShowMentions(false);
        inputRef.current?.focus();
    };

    const handleSubmit = () => {
        if (!allowEmpty && !content.trim()) return;

        // Extract @mentions
        const mentionRegex = /@(\w+(?:\s\w+)?)/g;
        const assignees: string[] = [];
        let match;
        while ((match = mentionRegex.exec(content)) !== null) {
            assignees.push(match[1]);
        }

        const finalContent = content.trim() ? content : '';
        onSubmit(finalContent, assignees);
    };

    const filteredParticipants = participants.filter(p =>
        p.toLowerCase().includes(mentionSearch.toLowerCase())
    );

    return (
        <div className="bg-white border border-gray-200 rounded-lg shadow-lg p-3 animate-in fade-in slide-in-from-bottom-2">
            <div className="text-[10px] text-gray-400 mb-2 flex items-center gap-1">
                <Link2 size={10} />
                Attached to: <span className="font-bold text-gray-600">{attachedTo}</span>
            </div>

            <div className="relative">
                <textarea
                    ref={inputRef}
                    value={content}
                    onChange={handleInput}
                    placeholder={placeholder ?? "Add a comment... Use @ to mention"}
                    className="w-full h-20 p-2 border border-gray-200 rounded text-xs resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && e.metaKey) {
                            handleSubmit();
                        }
                        if (e.key === 'Escape') {
                            onCancel();
                        }
                    }}
                />

                {/* Mention dropdown */}
                {showMentions && filteredParticipants.length > 0 && (
                    <div className="absolute bottom-full left-0 mb-1 bg-white border border-gray-200 rounded shadow-lg max-h-32 overflow-y-auto z-50">
                        {filteredParticipants.map(p => (
                            <button
                                key={p}
                                onClick={() => insertMention(p)}
                                className="w-full px-3 py-1.5 text-left text-xs hover:bg-gray-100 flex items-center gap-2"
                            >
                                <AtSign size={10} className="text-blue-500" />
                                {p}
                            </button>
                        ))}
                    </div>
                )}
            </div>

            <div className="flex items-center justify-between mt-2">
                <button
                    onClick={onCancel}
                    className="text-[10px] text-gray-400 hover:text-gray-600"
                >
                    Cancel (Esc)
                </button>
                <button
                    onClick={handleSubmit}
                    disabled={!allowEmpty && !content.trim()}
                    className="px-3 py-1.5 bg-blue-500 text-white rounded text-[10px] font-bold flex items-center gap-1 hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    <Send size={10} />
                    Submit (Cmd+Enter)
                </button>
            </div>
        </div>
    );
};

// Single Comment Card
const CommentCard: React.FC<{
    comment: SpatialComment;
    onResolve: () => void;
    onDelete: () => void;
    onLinkToMeeting: () => void;
}> = ({ comment, onResolve, onDelete, onLinkToMeeting }) => {
    const [showMenu, setShowMenu] = useState(false);

    // Parse @mentions for highlighting
    const highlightMentions = (text: string) => {
        const parts = text.split(/(@\w+(?:\s\w+)?)/g);
        return parts.map((part, i) => {
            if (part.startsWith('@')) {
                return (
                    <span key={i} className="text-blue-500 font-bold bg-blue-50 px-0.5 rounded">
                        {part}
                    </span>
                );
            }
            return part;
        });
    };

    return (
        <div
            className={clsx(
                "bg-white border rounded-lg p-3 transition-all",
                comment.resolved
                    ? "border-gray-200 opacity-60"
                    : "border-gray-200 hover:border-gray-300 hover:shadow-sm"
            )}
        >
            {/* Header */}
            <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2">
                    <div
                        className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[9px] font-bold"
                        style={{ backgroundColor: comment.authorColor }}
                    >
                        {comment.author[0]}
                    </div>
                    <div>
                        <div className="text-xs font-bold text-gray-700">{comment.author}</div>
                        <div className="text-[9px] text-gray-400">
                            {new Date(comment.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </div>
                    </div>
                </div>

                <div className="relative">
                    <button
                        onClick={() => setShowMenu(!showMenu)}
                        className="p-1 hover:bg-gray-100 rounded"
                    >
                        <MoreVertical size={12} className="text-gray-400" />
                    </button>

                    {showMenu && (
                        <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded shadow-lg z-50 min-w-32">
                            <button
                                onClick={() => { onResolve(); setShowMenu(false); }}
                                className="w-full px-3 py-2 text-left text-xs hover:bg-gray-50 flex items-center gap-2"
                            >
                                <CheckCircle2 size={12} className="text-green-500" />
                                {comment.resolved ? 'Unresolve' : 'Resolve'}
                            </button>
                            <button
                                onClick={() => { onLinkToMeeting(); setShowMenu(false); }}
                                className="w-full px-3 py-2 text-left text-xs hover:bg-gray-50 flex items-center gap-2"
                            >
                                <Link2 size={12} className="text-blue-500" />
                                Link to Meeting
                            </button>
                            <hr className="my-1" />
                            <button
                                onClick={() => { if (!comment.preReview) { onDelete(); setShowMenu(false); } }}
                                disabled={!!comment.preReview}
                                title={comment.preReview ? 'Pre-review items are managed in the Review panel / setup page' : undefined}
                                className={`w-full px-3 py-2 text-left text-xs flex items-center gap-2 ${comment.preReview ? 'text-gray-300 cursor-not-allowed' : 'hover:bg-red-50 text-red-600'}`}
                            >
                                <Trash2 size={12} />
                                Delete{comment.preReview ? ' (Pre-Review)' : ''}
                            </button>
                        </div>
                    )}
                </div>
            </div>

            {/* Pre-Review badge — set for comments synthesized from the curated review config */}
            {comment.preReview && (
                <div className="mb-2 inline-flex items-center gap-1 text-[8px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-700 border border-emerald-500/30">
                    <span className="w-1 h-1 bg-emerald-500 rounded-full" /> Pre-Review · {comment.preReviewSourceKind === 'viewpoint' ? 'Viewpoint' : 'Pin'}
                </div>
            )}

            {/* Attached component */}
            <div className="text-[9px] text-gray-400 mb-2 flex items-center gap-1">
                <Link2 size={8} />
                {comment.attachedToNodeName}
            </div>

            {/* Content */}
            {comment.type === 'drawing' && comment.drawingData ? (
                <div className="mb-2">
                    <img
                        src={comment.drawingData}
                        alt="Drawing"
                        className="w-full rounded border border-gray-100"
                    />
                    {comment.content && (
                        <div className="text-xs text-gray-600 mt-2 leading-relaxed">
                            {highlightMentions(comment.content)}
                        </div>
                    )}
                </div>
            ) : (
                <div className="text-xs text-gray-600 leading-relaxed">
                    {highlightMentions(comment.content)}
                </div>
            )}

            {/* Assignees */}
            {comment.assignees.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                    {comment.assignees.map((assignee, i) => (
                        <span
                            key={i}
                            className="text-[9px] bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded-full"
                        >
                            @{assignee}
                        </span>
                    ))}
                </div>
            )}

            {/* Status indicators */}
            <div className="flex items-center gap-2 mt-2 pt-2 border-t border-gray-100">
                {comment.resolved && (
                    <span className="text-[9px] text-green-600 flex items-center gap-1">
                        <CheckCircle2 size={10} />
                        Resolved
                    </span>
                )}
                {comment.linkedToMeeting && (
                    <span className="text-[9px] text-purple-600 flex items-center gap-1">
                        <Link2 size={10} />
                        In Meeting
                    </span>
                )}
            </div>
        </div>
    );
};

// Main Comments Panel
const CommentsPanel: React.FC = () => {
    const {
        comments,
        commentMode,
        setCommentMode,
        pendingCommentPosition,
        pendingCommentNodeId,
        pendingCommentNodeName,
        setPendingComment,
        addComment,
        updateComment,
        deleteComment,
        resolveComment,
        currentUser,
        currentUserColor,
        addChatMessage,
        setDrawingCanvas,
        drawingCanvas,
        commentsExpandedInScene,
        toggleCommentsExpandedInScene,
        setDrawingInteractionActive,
        setShowDrawingCanvas
    } = useStore();

    const { broadcastCommentAdd, broadcastCommentUpdate, broadcastCommentDelete, broadcastCommentResolve, broadcastReviewConfig } = usePresence();

    const [filter, setFilter] = useState<'all' | 'open' | 'resolved'>('all');

    const filteredComments = comments.filter(c => {
        if (filter === 'open') return !c.resolved;
        if (filter === 'resolved') return c.resolved;
        return true;
    });

    const handleNewComment = () => {
        setCommentMode('placing-comment');
    };

    const handleNewDrawing = () => {
        // First, user selects anchor point on 3D model, then drawing canvas opens
        setCommentMode('placing-drawing');
    };

    const handleCancelPlacement = () => {
        setCommentMode('none');
        setPendingComment(null, null, null);
        setShowDrawingCanvas(false);
        setDrawingCanvas(null);
        setDrawingInteractionActive(false);
    };

    const handleSubmitComment = (content: string, assignees: string[]) => {
        if (!pendingCommentPosition || !pendingCommentNodeId || !pendingCommentNodeName) return;

        const newComment: SpatialComment = {
            id: Math.random().toString(36).substr(2, 9),
            type: 'text',
            content,
            author: currentUser,
            authorColor: currentUserColor,
            timestamp: Date.now(),
            position: pendingCommentPosition,
            attachedToNodeId: pendingCommentNodeId,
            attachedToNodeName: pendingCommentNodeName,
            assignees,
            resolved: false,
            linkedToMeeting: false
        };

        addComment(newComment);
        broadcastCommentAdd(newComment);
        setCommentMode('none');
        setPendingComment(null, null, null);
    };

    const handleSubmitDrawing = (content: string, assignees: string[]) => {
        if (!pendingCommentPosition || !pendingCommentNodeId || !pendingCommentNodeName || !drawingCanvas) return;
        const safeContent = content.trim() ? content : 'Drawing annotation';

        const newComment: SpatialComment = {
            id: Math.random().toString(36).substr(2, 9),
            type: 'drawing',
            content: safeContent,
            drawingData: drawingCanvas,
            author: currentUser,
            authorColor: currentUserColor,
            timestamp: Date.now(),
            position: pendingCommentPosition,
            attachedToNodeId: pendingCommentNodeId,
            attachedToNodeName: pendingCommentNodeName,
            assignees,
            resolved: false,
            linkedToMeeting: false
        };

        addComment(newComment);
        broadcastCommentAdd(newComment);
        setCommentMode('none');
        setPendingComment(null, null, null);
        setShowDrawingCanvas(false);
        setDrawingCanvas(null);
    };

    const handleResolve = (id: string) => {
        resolveComment(id);
        broadcastCommentResolve(id);
    };

    const handleDelete = (id: string) => {
        // If this comment was produced by committing a curated pin, clear the
        // pin's committedCommentId so it can be committed again. Broadcast the
        // config change so every client sees the pin become available again.
        const clearedConfig = useActiveReviewStore.getState().clearCommittedCommentId(id);
        deleteComment(id);
        broadcastCommentDelete(id);
        if (clearedConfig) {
            broadcastReviewConfig(clearedConfig);
        }
    };

    const handleLinkToMeeting = (comment: SpatialComment) => {
        // Add comment to meeting transcript
        addChatMessage({
            id: Math.random().toString(36).substr(2, 9),
            agentId: 'USER',
            text: `[Comment on ${comment.attachedToNodeName}] ${comment.content}`,
            timestamp: Date.now()
        });
        updateComment(comment.id, { linkedToMeeting: true });
        broadcastCommentUpdate(comment.id, { linkedToMeeting: true });
    };

    return (
        <div className="h-full flex flex-col">
            {/* Header */}
            <div className="p-3 border-b border-gray-100 bg-gray-50/50">
                <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                        <MessageSquare size={14} className="text-gray-500" />
                        <span className="text-xs font-bold text-gray-700">Comments</span>
                        <span className="text-[9px] bg-gray-200 text-gray-600 px-1.5 rounded-full">
                            {comments.filter(c => !c.resolved).length}
                        </span>
                    </div>

                    {/* Filter dropdown */}
                    <select
                        value={filter}
                        onChange={(e) => setFilter(e.target.value as any)}
                        className="text-[10px] border border-gray-200 rounded px-2 py-1 bg-white"
                    >
                        <option value="all">All</option>
                        <option value="open">Open</option>
                        <option value="resolved">Resolved</option>
                    </select>
                </div>

                {/* Expand/Collapse All Toggle */}
                {comments.length > 0 && (
                    <button
                        onClick={toggleCommentsExpandedInScene}
                        className={clsx(
                            "w-full px-3 py-2 rounded text-[10px] font-bold flex items-center justify-center gap-2 transition-all border",
                            commentsExpandedInScene
                                ? "bg-blue-500 text-white border-blue-500"
                                : "bg-white text-gray-600 border-gray-200 hover:border-gray-400"
                        )}
                    >
                        {commentsExpandedInScene ? (
                            <>
                                <Minimize2 size={12} />
                                Collapse All in Scene
                            </>
                        ) : (
                            <>
                                <Maximize2 size={12} />
                                Expand All in Scene
                            </>
                        )}
                    </button>
                )}
            </div>

            {/* Action buttons */}
            <div className="p-2 border-b border-gray-100 flex flex-col gap-2">
                {commentMode === 'none' ? (
                    <>
                        <div className="flex gap-2">
                            <button
                                onClick={handleNewComment}
                                className="flex-1 px-3 py-2 bg-blue-500 text-white rounded text-[10px] font-bold flex items-center justify-center gap-1 hover:bg-blue-600"
                            >
                                <Plus size={12} />
                                Comment
                            </button>
                            <button
                                onClick={handleNewDrawing}
                                className="flex-1 px-3 py-2 bg-purple-500 text-white rounded text-[10px] font-bold flex items-center justify-center gap-1 hover:bg-purple-600"
                            >
                                <Pencil size={12} />
                                Drawing
                            </button>
                        </div>
                        <div className="text-[10px] text-gray-400 text-center">
                            Adjust the view to the desired perspective, then press Drawing to annotate the screen.
                        </div>
                    </>
                ) : (
                    <div className={`flex-1 border rounded p-2 text-center ${commentMode === 'placing-drawing' ? 'bg-purple-50 border-purple-200' : 'bg-blue-50 border-blue-200'}`}>
                        <div className={`text-[10px] font-bold mb-1 ${commentMode === 'placing-drawing' ? 'text-purple-600' : 'text-blue-600'}`}>
                            {commentMode === 'placing-comment' && 'Click on the 3D model to place comment'}
                            {commentMode === 'placing-drawing' && 'Click on the 3D model to anchor your drawing'}
                            {commentMode === 'drawing' && 'Drawing mode active - draw on the screen'}
                        </div>
                        <button
                            onClick={handleCancelPlacement}
                            className={`text-[10px] flex items-center gap-1 mx-auto ${commentMode === 'placing-drawing' ? 'text-purple-500 hover:text-purple-700' : 'text-blue-500 hover:text-blue-700'}`}
                        >
                            <X size={10} />
                            Cancel
                        </button>
                    </div>
                )}
            </div>

            {/* Comment input form (when position is selected for text comment) */}
            {commentMode === 'placing-comment' && pendingCommentPosition && pendingCommentNodeName && (
                <div className="p-2">
                    <CommentInputForm
                        onSubmit={handleSubmitComment}
                        onCancel={handleCancelPlacement}
                        attachedTo={pendingCommentNodeName}
                    />
                </div>
            )}

            {/* Drawing comment input (after drawing is done) */}
            {drawingCanvas && pendingCommentNodeName && (
                <div className="p-2">
                    <div className="bg-white border border-gray-200 rounded-lg p-3">
                        <div className="text-[10px] text-gray-400 mb-2">Drawing Preview:</div>
                        <img src={drawingCanvas} alt="Drawing" className="w-full rounded border border-gray-100 mb-2" />
                        <CommentInputForm
                            onSubmit={handleSubmitDrawing}
                            onCancel={handleCancelPlacement}
                            attachedTo={pendingCommentNodeName}
                            allowEmpty
                            placeholder="Add a note (optional)... Use @ to mention"
                        />
                    </div>
                </div>
            )}

            {/* Comments list */}
            <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-2">
                {filteredComments.length === 0 ? (
                    <div className="text-center p-8 text-gray-400 text-xs italic flex flex-col items-center gap-2">
                        <MessageSquare size={24} className="opacity-20" />
                        {filter === 'all' ? 'No comments yet' :
                         filter === 'open' ? 'No open comments' : 'No resolved comments'}
                    </div>
                ) : (
                    filteredComments.map(comment => (
                        <CommentCard
                            key={comment.id}
                            comment={comment}
                            onResolve={() => handleResolve(comment.id)}
                            onDelete={() => handleDelete(comment.id)}
                            onLinkToMeeting={() => handleLinkToMeeting(comment)}
                        />
                    ))
                )}
            </div>
        </div>
    );
};

export default CommentsPanel;

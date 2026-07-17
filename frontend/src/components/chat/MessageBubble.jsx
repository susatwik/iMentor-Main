import React, { useEffect, useRef, useState, useCallback, memo } from 'react';
import { marked } from 'marked';
import Prism from 'prismjs';
import toast from 'react-hot-toast';
import Animate from '../core/Animate.jsx';
import { ChevronDown, Link as LinkIcon, Zap, Server, Volume2, StopCircle, ServerCrash, Copy, Check, Lightbulb, ThumbsUp, ThumbsDown, ShieldCheck, GitFork, FlaskConical, MoreHorizontal, RefreshCw, ChevronLeft, ChevronRight, AlertCircle } from 'lucide-react'; // Added AlertCircle
import ThinkingDropdown from './ThinkingDropdown.jsx';
import TypingIndicator from './TypingIndicator.jsx';
import { useTextToSpeech } from '../../hooks/useTextToSpeech.js';
import IconButton from '../core/IconButton.jsx';
import { renderMarkdown } from '../../utils/markdownUtils';
import { getPlainTextFromMarkdown, copyToClipboard } from '../../utils/helpers.js';
import DOMPurify from 'dompurify';
import { useTypingEffect } from '../../hooks/useTypingEffect.js';
import api from '../../services/api.js';
import MindmapViewer from '../analysis/MindmapViewer.jsx';

marked.setOptions({ breaks: true, gfm: true });

const createMarkup = (markdownText) => {
    if (!markdownText) return { __html: '' };
    return renderMarkdown(markdownText);
};

const escapeHtml = (unsafe) => {
    if (typeof unsafe !== 'string') return '';
    return unsafe.replace(/&/g, "&").replace(/</g, "<").replace(/>/g, ">").replace(/"/g, `"`).replace(/'/g, "'");
};

const AnimatedThinking = ({ content }) => {
    const [completedTyping, setCompletedTyping] = useState('');
    const [currentTyping, setCurrentTyping] = useState('');
    const [isWaiting, setIsWaiting] = useState(true);
    const lastContentRef = useRef('');

    useEffect(() => {
        if (content && content.length > lastContentRef.current.length) {
            const newChunk = content.substring(lastContentRef.current.length);
            setCurrentTyping(newChunk);
            setIsWaiting(false);
            lastContentRef.current = content;
        }
    }, [content]);

    const onTypingComplete = useCallback(() => {
        setCompletedTyping(prev => prev + currentTyping);
        setCurrentTyping('');
        setIsWaiting(true);
    }, [currentTyping]);

    const animatedChunk = useTypingEffect(currentTyping, 4, onTypingComplete);
    const combinedText = completedTyping + animatedChunk;

    return (
        <div className="prose prose-xs dark:prose-invert max-w-none text-text-muted-light dark:text-text-muted-dark">
            <div dangerouslySetInnerHTML={createMarkup(combinedText)} />
            {isWaiting && <span className="animate-pulse"> Thinking...</span>}
        </div>
    );
};

const CodeBlockWithCopyButton = ({ children, codeText }) => {
    const [copied, setCopied] = useState(false);
    const codeRef = useRef(null);

    useEffect(() => {
        if (codeRef.current) {
            Prism.highlightAllUnder(codeRef.current);
        }
    }, [children, copied]);

    const handleCopyCode = async () => {
        const success = await copyToClipboard(codeText);
        if (success) {
            setCopied(true);
            toast.success('Code copied!');
            setTimeout(() => setCopied(false), 1500);
        } else {
            toast.error('Failed to copy code.');
        }
    };

    return (
        <div className="relative group/code" ref={codeRef}>
            <div dangerouslySetInnerHTML={{ __html: children }} />
            <button
                onClick={handleCopyCode}
                title={copied ? 'Copied!' : 'Copy code'}
                disabled={copied}
                className="absolute top-1 right-1 p-1.5 rounded-md cursor-pointer text-text-muted-dark bg-gray-700/80 backdrop-blur-sm transition-opacity duration-200 opacity-0 group-hover/code:opacity-100"
            >
                <Animate
                    as="span"
                    key={copied ? 'check' : 'copy'}
                    animation="scale-in"
                    duration="0.15s"
                >
                    {copied ? <Check size={16} className="text-black dark:text-white" /> : <Copy size={16} />}
                </Animate>
            </button>
        </div>
    );
};

const parseAndRenderMarkdown = (markdownText, messageId) => {
    if (!markdownText) return [];

    let htmlString = createMarkup(markdownText).__html;

    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlString, 'text/html');

    const resultNodes = [];
    let currentHtmlBuffer = '';
    // Deterministic counter — never use Math.random() here; random keys force
    // React to unmount+remount every node on each streaming token, causing shaking.
    let nodeIndex = 0;

    const flushHtmlBuffer = () => {
        if (currentHtmlBuffer) {
            resultNodes.push(
                <div key={`html-${messageId}-${nodeIndex++}`}
                    dangerouslySetInnerHTML={{ __html: currentHtmlBuffer }} />
            );
            currentHtmlBuffer = '';
        }
    };

    const traverse = (node) => {
        if (!node) return;

        if (node.nodeName === 'PRE') {
            flushHtmlBuffer();

            const codeElement = node.querySelector('code');
            const codeText = codeElement ? codeElement.textContent : '';

            // Render mermaid diagrams with the MindmapViewer instead of a plain code block
            const language = Array.from(codeElement?.classList || [])
                .find(cls => cls.startsWith('language-'))
                ?.replace('language-', '');
            if (language === 'mermaid') {
                resultNodes.push(
                    <div key={`mermaid-${messageId}-${nodeIndex++}`} className="my-3 rounded-lg overflow-hidden border border-gray-700 w-full" style={{ maxHeight: '350px', overflowY: 'auto' }}>
                        <MindmapViewer mermaidCode={codeText} />
                    </div>
                );
                return;
            }

            const preOuterHtml = node.outerHTML;

            resultNodes.push(
                <CodeBlockWithCopyButton
                    key={`code-${messageId}-${nodeIndex++}`}
                    codeText={codeText}
                >
                    {preOuterHtml}
                </CodeBlockWithCopyButton>
            );
            return;
        }

        if (node.nodeType === Node.TEXT_NODE) {
            currentHtmlBuffer += node.nodeValue;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            currentHtmlBuffer += node.outerHTML;
            return;
        }

        Array.from(node.childNodes).forEach(traverse);
    };

    Array.from(doc.body.children).forEach(traverse);

    flushHtmlBuffer();

    return resultNodes;
};

const CriticalThinkingCue = ({ icon: Icon, label, text, color, onClick }) => {
    const colorClasses = {
        sky: {
            bg: "bg-black dark:bg-white",
            text: "text-white dark:text-black",
            hoverBg: "hover:bg-gray-900 dark:hover:bg-gray-100",
            iconText: "text-white dark:text-black",
        },
        amber: {
            bg: "bg-gray-100 dark:bg-gray-800",
            text: "text-black dark:text-white",
            hoverBg: "hover:bg-gray-200 dark:hover:bg-gray-700",
            iconText: "text-black dark:text-white",
        },
        emerald: {
            bg: "bg-gray-200 dark:bg-gray-700",
            text: "text-black dark:text-white",
            hoverBg: "hover:bg-gray-300 dark:hover:bg-gray-600",
            iconText: "text-black dark:text-white",
        }
    };
    const styles = colorClasses[color] || colorClasses.sky;

    return (
        <button
            onClick={onClick}
            className={`w-full text-left p-2.5 rounded-lg transition-colors duration-200 ${styles.bg} ${styles.hoverBg}`}
        >
            <div className="flex items-center gap-2 mb-1">
                <Icon size={16} className={styles.iconText} />
                <span className={`text-xs font-bold ${styles.text}`}>{label}</span>
            </div>
            <p className={`text-xs ${styles.text}`}>{text}</p>
        </button>
    );
};




function MessageBubble({ sender, text, thinking, references, timestamp, sourcePipeline, isStreaming, criticalThinkingCues, onCueClick, messageId, logId, status, onAnalyze, steps, confidenceScore, historyVersions, isLastAiMessage, onTryAgain, isError, xpDelta }) {
    const isUser = sender === 'user';
    const [currentVersionIndex, setCurrentVersionIndex] = useState(historyVersions ? historyVersions.length - 1 : 0);

    // Update index when versions length changes (new version added)
    useEffect(() => {
        if (historyVersions && historyVersions.length > 0) {
            setCurrentVersionIndex(historyVersions.length - 1);
        }
    }, [historyVersions?.length]);

    const hasVersions = historyVersions && historyVersions.length > 0;
    const activeMessage = hasVersions ? historyVersions[currentVersionIndex] : { text, thinking, references, timestamp, sourcePipeline, isStreaming, criticalThinkingCues, logId, status, steps, confidenceScore, isError };

    // Destructure active properties to be used in rendering
    const {
        text: activeText,
        thinking: activeThinking,
        references: activeReferences,
        timestamp: activeTimestamp,
        sourcePipeline: activeSourcePipeline,
        isStreaming: activeIsStreaming,
        criticalThinkingCues: activeCriticalThinkingCues,
        logId: activeLogId,
        status: activeStatus,
        steps: activeSteps,
        confidenceScore: activeConfidenceScore,
        isError: activeIsError
    } = activeMessage;

    const [isDropdownOpen, setIsDropdownOpen] = useState(false);
    const [isMenuOpen, setIsMenuOpen] = useState(false); // Menu state
    const [feedbackSent, setFeedbackSent] = useState(null);
    const contentRef = useRef(null);
    const { speak, cancel, isSpeaking } = useTextToSpeech();

    const [isCopied, setIsCopied] = useState(false);
    const mainContent = activeText || '';
    const thinkingContent = activeThinking;
    const hasSteps = activeSteps && activeSteps.length > 0;
    const isTutor = activeSourcePipeline && activeSourcePipeline.includes('tutor');
    // Show dropdown if there is thinking content, structured steps, OR if there is an active status (EXCEPT in Tutor Mode)
    const showThinkingDropdown = !isUser && !isTutor && (thinkingContent !== null || hasSteps || (activeIsStreaming && activeStatus));

    // Memoize the rich post-stream render so state changes (dropdown, feedback, etc.)
    // don't re-run the expensive DOMParser traversal unnecessarily.
    const renderedContent = React.useMemo(
        () => parseAndRenderMarkdown(mainContent, messageId),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [mainContent, messageId]
    );

    useEffect(() => {
        if (contentRef.current && !activeIsStreaming) {
            const timer = setTimeout(() => {
                Prism.highlightAllUnder(contentRef.current);
            }, 50);
            return () => clearTimeout(timer);
        }
    }, [activeIsStreaming, mainContent]);

    const handleFeedback = async (feedbackType) => {
        if (feedbackSent) return; // Prevent multiple submissions
        setFeedbackSent(feedbackType);
        try {
            await api.submitFeedback(activeLogId, feedbackType);
            toast.success('Thanks for your feedback!');
        } catch (error) {
            toast.error('Could not submit feedback.');
            setFeedbackSent(null); // Allow user to try again
        }
    };


    const handleCopy = async () => {
        if (isCopied) return;
        const plainTextToCopy = getPlainTextFromMarkdown(mainContent);
        const success = await copyToClipboard(plainTextToCopy);

        if (success) {
            setIsCopied(true);
            setTimeout(() => setIsCopied(false), 1500);
            toast.success('Message copied!');
        } else {
            toast.error('Failed to copy message.');
        }
    };

    const formatTimestamp = (ts) => {
        if (!ts) return '';
        return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };

    const getPipelineIcon = () => {
        if (!activeSourcePipeline) return null;
        const lower = activeSourcePipeline.toLowerCase();
        if (lower.includes('ollama')) return <Zap size={12} className="text-black dark:text-white" title="Ollama" />;
        if (lower.includes('gemini')) return <Server size={12} className="text-black dark:text-white" title="Gemini" />;
        if (lower.includes('rag')) return <Zap size={12} className="text-black dark:text-white" title="RAG" />;
        if (lower.includes('error')) return <ServerCrash size={12} className="text-gray-500" title="Error" />;
        return null;
    };

    return (
        <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} w-full group`}>
            <div className={`message-bubble-wrapper max-w-[75%] md:max-w-[65%] ${isStreaming ? 'w-full' : ''}`}>
                {showThinkingDropdown && (
                    <div className="mb-1.5">
                        <ThinkingDropdown
                            isOpen={isDropdownOpen}
                            setIsOpen={setIsDropdownOpen}
                            isStreaming={activeIsStreaming}
                            status={activeStatus}
                            steps={activeSteps}
                            confidenceScore={activeConfidenceScore}
                        >
                            {activeIsStreaming
                                ? <AnimatedThinking content={thinkingContent || ''} />
                                : <div className="prose prose-xs dark:prose-invert max-w-none text-[#b0b0b0]" dangerouslySetInnerHTML={createMarkup(thinkingContent)} />
                            }
                        </ThinkingDropdown>
                    </div>
                )}

                <div className={`message-bubble relative px-4 py-2.5 rounded-lg break-words ${isUser
                    ? 'bg-white/10 text-white border border-white/20 shadow-[0_2px_8px_rgba(0,0,0,0.3)]'
                    : 'bg-[#1a1a1a] text-white border border-[#4a4a4a] shadow-[0_2px_12px_rgba(0,0,0,0.4)]'
                    }`}>

                    {/* Status Badge (like Tutor Mode) — only visible while streaming */}
                    {!isUser && activeIsStreaming && activeStatus && (
                        <div className="mb-1">
                            <span className="inline-block px-2 py-0.5 text-[10px] font-medium rounded bg-blue-600/80 text-white">
                                {activeStatus}
                            </span>
                        </div>
                    )}

                    <div ref={contentRef} className="prose prose-xs dark:prose-invert max-w-none message-content text-sm leading-snug text-white">
                        {activeIsError ? (
                            <div className="flex flex-col gap-3 py-2">
                                <div className="flex items-start gap-3 bg-red-500/10 border border-red-500/20 rounded-lg p-4">
                                    <div className="bg-red-500/20 p-2 rounded-full">
                                        <AlertCircle className="text-red-500" size={20} />
                                    </div>
                                    <div className="flex-1">
                                        <h4 className="text-red-500 font-bold text-sm mb-1 uppercase tracking-wider">Service Interruption</h4>
                                        <p className="text-white text-sm leading-relaxed">
                                            {mainContent || "Our AI service is experiencing a temporary hiccup. Please try again in a few moments."}
                                        </p>
                                        {activeMessage.providerDetail && (
                                            <pre className="mt-2 text-xs text-red-200 bg-red-900/10 p-2 rounded overflow-auto">{activeMessage.providerDetail}</pre>
                                        )}
                                    </div>
                                </div>
                                <button
                                    onClick={onTryAgain}
                                    className="flex items-center justify-center gap-2 w-full py-2.5 bg-white dark:bg-white text-black font-bold rounded-lg hover:opacity-90 transition-all active:scale-95 shadow-lg group/btn"
                                >
                                    <RefreshCw size={16} className="group-hover/btn:rotate-180 transition-transform duration-500" />
                                    Regenerate Response
                                </button>
                            </div>
                        ) : (
                            <>
                                {activeIsStreaming ? (
                                    // While streaming: render a single stable div so React never
                                    // unmounts/remounts nodes on each token (eliminates page shaking).
                                    // Copy buttons and syntax highlighting appear once streaming ends.
                                    <>
                                        {mainContent.length === 0
                                            ? <div className="streaming-cursor"><TypingIndicator status={activeStatus} /></div>
                                            : <>
                                                <div dangerouslySetInnerHTML={createMarkup(mainContent)} />
                                                <span className="streaming-cursor inline-block w-1 h-4 ml-1 bg-white animate-pulse align-middle" />
                                              </>
                                        }
                                    </>
                                ) : (
                                    // After streaming: full rich render with copy buttons, mermaid, etc.
                                    renderedContent
                                )}
                            </>
                        )}
                    </div>


                    {/* XP Delta Badge — visible on tutor bot responses only */}
                    {isTutor && !isUser && !activeIsStreaming && xpDelta && (
                        <div
                            className="inline-flex items-center gap-1 mt-2 px-2.5 py-1 rounded-full text-[11px] font-bold select-none"
                            style={{
                                background: xpDelta.type === 'gain'
                                    ? 'rgba(107, 207, 127, 0.15)'
                                    : xpDelta.type === 'loss'
                                        ? 'rgba(255, 107, 107, 0.15)'
                                        : 'rgba(150, 150, 150, 0.12)',
                                color: xpDelta.type === 'gain' ? '#6bcf7f'
                                    : xpDelta.type === 'loss' ? '#ff6b6b'
                                    : '#aaa',
                                border: `1px solid ${xpDelta.type === 'gain'
                                    ? 'rgba(107, 207, 127, 0.35)'
                                    : xpDelta.type === 'loss'
                                        ? 'rgba(255, 107, 107, 0.35)'
                                        : 'rgba(150,150,150,0.25)'}`,
                                animation: 'xpPop 0.45s cubic-bezier(0.175, 0.885, 0.32, 1.275) both',
                            }}
                            title={`${xpDelta.label} (${xpDelta.classification || ''} at ${xpDelta.cognitiveLevel || ''})`}
                        >
                            &#9889; {xpDelta.label}
                        </div>
                    )}

                    <div className="flex items-center justify-start mt-2 text-[11px] gap-2 select-none">
                        {/* Version Pagination */}
                        {hasVersions && historyVersions.length > 1 && (
                            <div className="flex items-center gap-1 bg-gray-100 dark:bg-gray-800 rounded-md px-1.5 py-0.5">
                                <button
                                    disabled={currentVersionIndex === 0}
                                    onClick={() => setCurrentVersionIndex(prev => prev - 1)}
                                    className="p-0.5 hover:text-black dark:hover:text-white disabled:opacity-30 transition-colors"
                                >
                                    <ChevronLeft size={12} />
                                </button>
                                <span className="text-[10px] font-medium text-text-muted-light dark:text-text-muted-dark min-w-[20px] text-center">
                                    {currentVersionIndex + 1} / {historyVersions.length}
                                </span>
                                <button
                                    disabled={currentVersionIndex === historyVersions.length - 1}
                                    onClick={() => setCurrentVersionIndex(prev => prev + 1)}
                                    className="p-0.5 hover:text-black dark:hover:text-white disabled:opacity-30 transition-colors"
                                >
                                    <ChevronRight size={12} />
                                </button>
                            </div>
                        )}

                        {!isUser && !activeIsStreaming && (
                            <div className="flex items-center gap-1.5 text-text-muted-light dark:text-text-muted-dark">
                                {/* Copy */}
                                <button
                                    onClick={handleCopy}
                                    title={isCopied ? 'Copied!' : 'Copy'}
                                    disabled={isCopied}
                                    className="p-1 hover:text-black dark:hover:text-white transition-colors"
                                >
                                    {isCopied ? <Check size={14} /> : <Copy size={14} />}
                                </button>

                                {/* Feedback */}
                                <div className="flex items-center gap-1">
                                    <button
                                        onClick={() => handleFeedback('positive')}
                                        disabled={!!feedbackSent}
                                        className={`p-1 hover:text-black dark:hover:text-white transition-colors ${feedbackSent === 'positive' ? 'text-green-500' : ''}`}
                                        title="Good response"
                                    >
                                        <ThumbsUp size={14} />
                                    </button>
                                    <button
                                        onClick={() => handleFeedback('negative')}
                                        disabled={!!feedbackSent}
                                        className={`p-1 hover:text-black dark:hover:text-white transition-colors ${feedbackSent === 'negative' ? 'text-red-500' : ''}`}
                                        title="Bad response"
                                    >
                                        <ThumbsDown size={14} />
                                    </button>
                                </div>

                                {/* Regenerate - Always show for last message if not streaming */}
                                {isLastAiMessage && (
                                    <button
                                        onClick={onTryAgain}
                                        title="Regenerate response"
                                        className="p-1 hover:text-black dark:hover:text-white transition-colors"
                                    >
                                        <RefreshCw size={14} />
                                    </button>
                                )}

                                {/* Read Aloud */}
                                <button
                                    onClick={() => isSpeaking ? cancel() : speak({ text: mainContent })}
                                    title={isSpeaking ? "Stop reading" : "Read aloud"}
                                    className={`p-1 hover:text-black dark:hover:text-white transition-colors ${isSpeaking ? 'animate-pulse text-primary' : ''}`}
                                >
                                    {isSpeaking ? <StopCircle size={14} /> : <Volume2 size={14} />}
                                </button>

                                {/* Menu */}
                                <div className="relative">
                                    <button
                                        onClick={() => setIsMenuOpen(!isMenuOpen)}
                                        className="p-1 hover:text-black dark:hover:text-white transition-colors"
                                        title="More options"
                                    >
                                        <MoreHorizontal size={14} />
                                    </button>

                                    {isMenuOpen && (
                                            <Animate
                                                animation="scale-in"
                                                className="absolute bottom-full left-0 mb-2 w-32 bg-surface-light dark:bg-surface-dark rounded-md shadow-lg border border-border-light dark:border-border-dark p-1 z-10"
                                            >
                                                <button
                                                    onClick={() => {
                                                        if (onAnalyze) onAnalyze(mainContent);
                                                        setIsMenuOpen(false);
                                                    }}
                                                    className="w-full text-left px-3 py-2 text-xs hover:bg-gray-100 dark:hover:bg-gray-700 rounded-sm flex items-center gap-2"
                                                >
                                                    <ShieldCheck size={12} />
                                                    Analyze Text
                                                </button>
                                            </Animate>
                                    )}
                                </div>

                                {/* Timestamp & Meta - Subtle at the end */}
                                <div className="flex items-center gap-2 ml-1 px-1.5 border-l border-border-light dark:border-border-dark opacity-60 text-[10px]">
                                    {getPipelineIcon()}
                                    <span>{formatTimestamp(activeTimestamp)}</span>
                                </div>
                            </div>
                        )}
                    </div>

                    {!activeIsStreaming && !isUser && activeReferences && activeReferences.length > 0 && (
                        <div className="message-metadata-container max-w-[85%] md:max-w-[75%] mt-1.5 pl-2">
                            <details className="group/details text-xs">
                                <summary className="flex items-center justify-between gap-1 cursor-pointer text-text-muted-light dark:text-text-muted-dark hover:text-black dark:hover:text-white transition-colors">
                                    <span className="flex items-center gap-1">
                                        <LinkIcon size={14} /> References
                                    </span>
                                    <ChevronDown size={14} className="transition-transform group-open/details:rotate-180" />
                                </summary>
                                <ul className="mt-1 pl-1 space-y-0.5 text-[0.7rem]">
                                    {activeReferences.map((ref, index) => (
                                        <li
                                            key={index}
                                            className="text-text-muted-light dark:text-text-muted-dark hover:text-text-light dark:hover:text-text-dark transition-colors truncate"
                                            title={`Preview: ${escapeHtml(ref.content_preview || '')}\nSource: ${escapeHtml(ref.source || '')}`}
                                        >
                                            <span className="font-semibold text-black dark:text-white">[{ref.number}]</span> {escapeHtml(ref.source)}
                                        </li>
                                    ))}
                                </ul>
                            </details>
                        </div>
                    )}

                    {!activeIsStreaming && !isUser && activeCriticalThinkingCues && (
                        <div
                            className="max-w-[85%] md:max-w-[75%] w-full mt-2 pl-2"
                        >
                            <div className="border-t border-dashed border-border-light dark:border-border-dark pt-2">
                                <h4 className="text-xs font-semibold text-text-muted-light dark:text-text-muted-dark flex items-center gap-1.5 mb-2">
                                    <Lightbulb size={14} />
                                    Critical Thinking Prompts
                                </h4>
                                <div className="space-y-2">
                                    {activeCriticalThinkingCues.verificationPrompt && (
                                        <CriticalThinkingCue
                                            onClick={() => onCueClick(activeCriticalThinkingCues.verificationPrompt)}
                                            icon={ShieldCheck}
                                            label="Verify & Validate"
                                            text={activeCriticalThinkingCues.verificationPrompt}
                                            color="sky"
                                        />
                                    )}
                                    {activeCriticalThinkingCues.alternativePrompt && (
                                        <CriticalThinkingCue
                                            onClick={() => onCueClick(activeCriticalThinkingCues.alternativePrompt)}
                                            icon={GitFork}
                                            label="Consider Alternatives"
                                            text={activeCriticalThinkingCues.alternativePrompt}
                                            color="amber"
                                        />
                                    )}
                                    {activeCriticalThinkingCues.applicationPrompt && (
                                        <CriticalThinkingCue
                                            onClick={() => onCueClick(activeCriticalThinkingCues.applicationPrompt)}
                                            icon={FlaskConical}
                                            label="Apply Your Knowledge"
                                            text={activeCriticalThinkingCues.applicationPrompt}
                                            color="emerald"
                                        />
                                    )}
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

export default memo(MessageBubble);
// frontend/src/components/course/CourseExplorerPage.jsx
// Full-screen "Admin Subjects" explorer.
// Phase 1 — course grid (all courses fetched dynamically from /api/subjects)
// Phase 2 — split-pane: left accordion tree (Modules→Topics→Subtopics) | center markdown note viewer
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import 'katex/dist/katex.min.css';
import mermaid from 'mermaid';
import api from '../../services/api.js';
import { useAppState } from '../../contexts/AppStateContext.jsx';
import {
    ArrowLeft, GraduationCap, BookOpen, Layers, Hash,
    ChevronDown, ChevronRight, Loader2, AlertTriangle,
    RefreshCw, FileText, MessageSquare, BookMarked,
    Search, X, Menu, Brain
} from 'lucide-react';
import CourseQuizModal from './CourseQuizModal.jsx';

// Initialise Mermaid once (dark theme to match UI)
mermaid.initialize({
    startOnLoad: false,
    theme: 'dark',
    themeVariables: {
        background:       '#0e1117',
        primaryColor:     '#1e2a3a',
        primaryTextColor: '#e2e8f0',
        lineColor:        '#4f6a8a',
        secondaryColor:   '#14202e',
        tertiaryColor:    '#0a0f18',
    },
    fontFamily: 'inherit',
    fontSize:   14,
});

// ─── helpers ──────────────────────────────────────────────────────────────────
const stripExt = (name = '') => name.replace(/\.[^.]+$/, '');

// Module-level sequence — guarantees globally unique IDs across all renders
let _mmdSeq = 0;

/** Strip LaTeX/escape sequences and newlines inside node labels */
function sanitizeMermaid(code) {
    return code
        .replace(/\\[(]/g, '(')    // \(  →  (
        .replace(/\\[)]/g, ')')    // \)  →  )
        .replace(/\\\[/g, '[')     // \[  →  [
        .replace(/\\\]/g, ']')     // \]  →  ]
        .replace(/\$\$?[^$]*\$\$?/g, '')               // strip $$...$$ inside labels
        .replace(/\[([^\]]*)\]/g, (_, inner) =>
            `[${inner.replace(/\r?\n/g, ' ').trim()}]` // flatten newlines inside [...]
        )
        .trim();
}

// ─── Mermaid diagram renderer ─────────────────────────────────────────────────
function MermaidDiagram({ code }) {
    const containerRef = useRef(null);
    const [ready, setReady]   = useState(false);
    const [error, setError]   = useState(null);

    useEffect(() => {
        if (!containerRef.current || !code?.trim()) return;
        let cancelled = false;
        setReady(false);
        setError(null);

        const id    = `mmd-${++_mmdSeq}`;
        const clean = sanitizeMermaid(code);

        // Mermaid v10 appends error/working elements to its render container.
        // Without a container it defaults to document.body, leaving bomb-emoji
        // error SVGs on the page that never get cleaned up.
        // Fix: give Mermaid a hidden off-screen div and remove it afterwards.
        const tempEl = document.createElement('div');
        tempEl.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;overflow:hidden;visibility:hidden;';
        document.body.appendChild(tempEl);

        const cleanup = () => {
            try { document.body.removeChild(tempEl); } catch {}
        };

        mermaid.render(id, clean, tempEl)
            .then(({ svg }) => {
                cleanup();
                if (cancelled || !containerRef.current) return;
                containerRef.current.innerHTML = svg;
                const svgEl = containerRef.current.querySelector('svg');
                if (svgEl) {
                    // removeAttribute('height') lets the viewBox aspect ratio drive height.
                    // style.height='auto' alone does NOT override the attribute in all browsers.
                    svgEl.setAttribute('width', '100%');
                    svgEl.removeAttribute('height');
                    svgEl.style.maxWidth  = '100%';
                    svgEl.style.maxHeight = '420px';
                    svgEl.style.height    = 'auto';
                    svgEl.style.display   = 'block';
                    svgEl.style.margin    = '0 auto';
                }
                setReady(true);
            })
            .catch(err => {
                cleanup();
                if (!cancelled) setError(String(err?.message || err));
            });

        return () => { cancelled = true; cleanup(); };
    }, [code]);

    if (error) {
        return (
            <pre className="text-xs text-gray-400 bg-white/5 border border-white/10 rounded-xl p-4 my-4 overflow-x-auto whitespace-pre-wrap leading-relaxed">
                {code}
            </pre>
        );
    }

    return (
        <div
            ref={containerRef}
            className={`my-6 overflow-x-auto rounded-xl bg-[#0a0d14] border border-white/8 p-4 transition-all duration-300 ${
                ready ? 'opacity-100 min-h-0' : 'opacity-0 min-h-[80px]'
            }`}
        />
    );
}

// ─── Markdown + LaTeX + Mermaid renderer ─────────────────────────────────────
function LectureMermaidMarkdown({ content }) {
    // Intercept at <pre> level — this way MermaidDiagram is NOT wrapped in <pre>
    // (intercepting only at <code> level leaves the prose-styled <pre> wrapper in place)
    const components = {
        pre({ node, children, ...props }) {
            const kids = React.Children.toArray(children);
            const codeEl = kids.find(c => c?.props?.className?.includes('language-mermaid'));
            if (codeEl) {
                const raw = Array.isArray(codeEl.props.children)
                    ? codeEl.props.children.join('')
                    : String(codeEl.props.children ?? '');
                return <MermaidDiagram code={raw.trim()} />;
            }
            return <pre {...props}>{children}</pre>;
        },
    };

    return (
        <div className="prose prose-invert prose-sm max-w-none
            prose-headings:font-semibold prose-headings:text-white
            prose-h1:text-xl prose-h1:mb-3
            prose-h2:text-lg prose-h2:mb-2 prose-h2:mt-5
            prose-h3:text-base prose-h3:mb-1.5 prose-h3:mt-4
            prose-p:text-gray-300 prose-p:leading-relaxed prose-p:my-2
            prose-li:text-gray-300 prose-li:my-0.5
            prose-ul:my-2 prose-ol:my-2
            prose-strong:text-white prose-strong:font-semibold
            prose-em:text-gray-200
            prose-code:text-indigo-300 prose-code:bg-white/5 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-xs prose-code:before:content-none prose-code:after:content-none
            prose-pre:bg-[#0e1117] prose-pre:border prose-pre:border-white/10 prose-pre:rounded-xl prose-pre:p-4
            prose-blockquote:border-indigo-500 prose-blockquote:text-gray-400 prose-blockquote:bg-white/3 prose-blockquote:px-4 prose-blockquote:py-1 prose-blockquote:rounded-r-lg
            prose-table:border-collapse prose-th:text-left prose-th:text-xs prose-th:text-gray-400 prose-th:font-semibold prose-th:border prose-th:border-white/10 prose-th:px-3 prose-th:py-1.5 prose-td:border prose-td:border-white/10 prose-td:px-3 prose-td:py-1.5 prose-td:text-sm prose-td:text-gray-300
            prose-hr:border-white/10
            [&_.katex]:text-gray-200 [&_.katex-display]:my-4 [&_.katex-display]:overflow-x-auto">
            <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkMath]}
                rehypePlugins={[rehypeRaw, [rehypeKatex, { strict: false, throwOnError: false }]]}
                components={components}
            >
                {content}
            </ReactMarkdown>
        </div>
    );
}

// ─── Subtopic item ─────────────────────────────────────────────────────────────
function SubtopicItem({ subtopic, topicName, isActive, onClick }) {
    return (
        <button
            onClick={onClick}
            className={`w-full text-left flex items-center gap-2 px-3 py-2 rounded-lg text-[13px] transition-all group
                ${isActive
                    ? 'bg-indigo-500/20 text-indigo-300 font-medium border border-indigo-500/30'
                    : 'text-gray-400 hover:text-gray-100 hover:bg-white/5 border border-transparent'}`}
        >
            <Hash size={11} className={`flex-shrink-0 mt-0.5 ${isActive ? 'text-indigo-400' : 'text-gray-600 group-hover:text-gray-400'}`} />
            <span className="truncate leading-snug">{subtopic.name}</span>
        </button>
    );
}

// ─── Topic item ────────────────────────────────────────────────────────────────
function TopicItem({ topic, activeSubtopic, onSubtopicSelect, defaultOpen }) {
    const [open, setOpen] = useState(defaultOpen || false);
    const hasActive = topic.subtopics?.some(s => s.id === activeSubtopic?.id);

    // Auto-expand if active child
    useEffect(() => {
        if (hasActive) setOpen(true);
    }, [hasActive]);

    return (
        <div>
            <button
                onClick={() => setOpen(o => !o)}
                className="w-full flex items-center gap-2 px-2 py-2 rounded-lg text-sm font-medium text-gray-300 hover:text-white hover:bg-white/5 transition-all group"
            >
                {open
                    ? <ChevronDown size={13} className="flex-shrink-0 text-gray-500" />
                    : <ChevronRight size={13} className="flex-shrink-0 text-gray-500" />}
                <BookMarked size={13} className={`flex-shrink-0 ${hasActive ? 'text-indigo-400' : 'text-indigo-400/50'}`} />
                <span className="truncate text-left text-[13px]">{topic.name || topic.id}</span>
                <span className="ml-auto text-[11px] text-gray-600 flex-shrink-0">
                    {topic.subtopics?.length || 0}
                </span>
            </button>

            {open && (
                <div className="ml-4 mt-0.5 space-y-0.5 border-l border-white/8 pl-2">
                    {(topic.subtopics || []).map(sub => (
                        <SubtopicItem
                            key={sub.id}
                            subtopic={sub}
                            topicName={topic.name}
                            isActive={activeSubtopic?.id === sub.id}
                            onClick={() => onSubtopicSelect({ ...sub, topicName: topic.name })}
                        />
                    ))}
                    {(!topic.subtopics || topic.subtopics.length === 0) && (
                        <p className="text-[11px] text-gray-700 pl-2 py-1 italic">No subtopics</p>
                    )}
                </div>
            )}
        </div>
    );
}

// ─── Module item ───────────────────────────────────────────────────────────────
function ModuleItem({ module, activeSubtopic, onSubtopicSelect, defaultOpen, onTakeQuiz }) {
    const [open, setOpen] = useState(defaultOpen || false);
    const hasActive = module.topics?.some(t =>
        t.subtopics?.some(s => s.id === activeSubtopic?.id)
    );

    useEffect(() => {
        if (hasActive) setOpen(true);
    }, [hasActive]);

    return (
        <div className={`rounded-xl overflow-hidden transition-all ${hasActive ? 'border border-indigo-500/30' : 'border border-white/8'}`}>
            <button
                onClick={() => setOpen(o => !o)}
                className="w-full flex items-center gap-2.5 px-3 py-3 text-left transition-all hover:bg-white/5 group"
            >
                <div className={`p-1.5 rounded-md flex-shrink-0 ${hasActive ? 'bg-indigo-500/30' : 'bg-indigo-500/15'}`}>
                    <Layers size={13} className={hasActive ? 'text-indigo-300' : 'text-indigo-400/70'} />
                </div>
                <span className="text-[13px] font-semibold text-gray-200 truncate flex-1 leading-snug">
                    {module.name || module.id}
                </span>
                <span className="text-[11px] text-gray-600 flex-shrink-0">
                    {module.topics?.length || 0} topics
                </span>
                {open
                    ? <ChevronDown size={13} className="text-gray-500 flex-shrink-0" />
                    : <ChevronRight size={13} className="text-gray-500 flex-shrink-0" />}
            </button>

            {open && (
                <div className="px-2 pb-2 space-y-0.5 border-t border-white/8 pt-1">
                    {(module.topics || []).map((topic, ti) => (
                        <TopicItem
                            key={topic.id || ti}
                            topic={topic}
                            activeSubtopic={activeSubtopic}
                            onSubtopicSelect={onSubtopicSelect}
                            defaultOpen={ti === 0}
                        />
                    ))}
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            if (typeof onTakeQuiz === 'function') {
                                onTakeQuiz({ moduleId: module.id, moduleName: module.name });
                            }
                        }}
                        className="w-full mt-2 flex items-center justify-center gap-1.5 py-1.5 bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/20 hover:border-indigo-500/45 text-indigo-300 rounded-lg text-xs font-semibold transition-all"
                    >
                        <Brain size={12} />
                        Take Module Quiz
                    </button>
                </div>
            )}
        </div>
    );
}

// ─── Left Sidebar (tree) ───────────────────────────────────────────────────────
function CourseSidebar({ courseName, structure, activeSubtopic, onSubtopicSelect, onBack, sidebarOpen, setSidebarOpen, onTakeQuiz }) {
    const modules = structure?.modules || [];
    const displayName = stripExt(courseName);

    return (
        <div
            className="flex flex-col h-full"
            style={{
                background: 'linear-gradient(180deg, #0d0f14 0%, #0a0c10 100%)',
                borderRight: '1px solid rgba(255,255,255,0.07)',
            }}
        >
            {/* Sidebar header */}
            <div className="flex items-center gap-2.5 px-4 py-3.5 border-b border-white/7 flex-shrink-0">
                <button
                    onClick={onBack}
                    className="p-1.5 rounded-lg text-gray-500 hover:text-white hover:bg-white/8 transition-all flex-shrink-0"
                    title="Back to courses"
                >
                    <ArrowLeft size={15} />
                </button>
                <div className="flex-1 min-w-0">
                    <p className="text-[10px] text-gray-600 uppercase tracking-widest font-bold">Course</p>
                    <h2 className="text-sm font-bold text-white truncate leading-tight">{displayName}</h2>
                </div>
                {/* Mobile toggle */}
                <button
                    className="md:hidden p-1.5 text-gray-500 hover:text-white rounded-lg hover:bg-white/8 transition-all"
                    onClick={() => setSidebarOpen(false)}
                >
                    <X size={14} />
                </button>
            </div>

            {/* Stats */}
            <div className="px-4 py-2 border-b border-white/7 flex-shrink-0">
                <div className="flex items-center gap-3 text-[11px] text-gray-600">
                    <span className="flex items-center gap-1">
                        <Layers size={10} className="text-indigo-500" />
                        {modules.length} modules
                    </span>
                    <span className="flex items-center gap-1">
                        <BookOpen size={10} className="text-indigo-500" />
                        {modules.reduce((acc, m) => acc + (m.topics?.length || 0), 0)} topics
                    </span>
                </div>
                {activeSubtopic && (
                    <div className="mt-1.5 flex items-center gap-1 text-[11px] text-indigo-400">
                        <div className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-pulse flex-shrink-0" />
                        <span className="truncate">Viewing: {activeSubtopic.name}</span>
                    </div>
                )}
            </div>

            {/* Tree */}
            <div className="flex-1 overflow-y-auto custom-scrollbar p-3 space-y-2">
                {modules.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16 gap-3 text-gray-600">
                        <BookOpen size={28} className="opacity-20" />
                        <p className="text-xs text-center leading-relaxed">
                            No modules found.<br />
                            <span className="text-[11px] text-gray-700">Run the course bootstrap to generate content.</span>
                        </p>
                    </div>
                ) : (
                    modules.map((mod, mi) => (
                        <ModuleItem
                            key={mod.id || mi}
                            module={mod}
                            activeSubtopic={activeSubtopic}
                            onSubtopicSelect={onSubtopicSelect}
                            defaultOpen={mi === 0}
                            onTakeQuiz={onTakeQuiz}
                        />
                    ))
                )}
            </div>
        </div>
    );
}

// ─── Center content pane ───────────────────────────────────────────────────────
function ContentPane({ courseName, activeSubtopic, onAskAI, sidebarOpen, setSidebarOpen }) {
    const [markdown, setMarkdown]   = useState('');
    const [matched, setMatched]     = useState(true);
    const [source, setSource]       = useState('');       // 'cache' | 'lecture_md' | 'generated'
    const [generating, setGenerating] = useState(false);  // first-time LLM generation
    const [loading, setLoading]     = useState(false);
    const [error, setError]         = useState(null);
    const scrollRef = useRef(null);

    useEffect(() => {
        if (!courseName || !activeSubtopic?.id) {
            setMarkdown('');
            return;
        }
        let mounted = true;
        setLoading(true);
        setGenerating(false);
        setError(null);
        setMarkdown('');

        // Show "generating" hint after 2 s if still loading (first-time LLM call)
        const hintTimer = setTimeout(() => {
            if (mounted && loading) setGenerating(true);
        }, 2000);

        api.getCourseLectureSection(
            courseName,
            activeSubtopic.id,
            activeSubtopic.name || '',
            activeSubtopic.topicName || '',
        )
            .then(data => {
                if (mounted) {
                    setMarkdown(data.markdown || '');
                    setMatched(data.matched !== false);
                    setSource(data.source || '');
                    setGenerating(false);
                }
            })
            .catch(e => {
                if (mounted) setError(e.response?.data?.message || e.message || 'Failed to load lecture');
            })
            .finally(() => { if (mounted) { setLoading(false); setGenerating(false); } });

        return () => { mounted = false; clearTimeout(hintTimer); };
    }, [courseName, activeSubtopic?.id]);

    // Scroll to top on subtopic change
    useEffect(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = 0;
    }, [activeSubtopic?.id]);

    // ── Empty state — no subtopic selected ──
    if (!activeSubtopic) {
        return (
            <div className="flex flex-col items-center justify-center h-full gap-6 px-8 text-center">
                {/* Mobile sidebar toggle */}
                <button
                    className="md:hidden absolute top-4 left-4 p-2 bg-white/5 rounded-lg text-gray-400 hover:text-white"
                    onClick={() => setSidebarOpen(true)}
                >
                    <Menu size={18} />
                </button>

                <div className="space-y-2">
                    <div className="inline-flex p-5 bg-indigo-500/10 rounded-2xl mb-2">
                        <BookOpen size={36} className="text-indigo-400/70" />
                    </div>
                    <h3 className="text-xl font-semibold text-white">Select a Lecture</h3>
                    <p className="text-sm text-gray-500 max-w-xs leading-relaxed">
                        Choose a subtopic from the course tree on the left to view its lecture notes here.
                    </p>
                </div>

                <div className="grid grid-cols-3 gap-3 text-center mt-4">
                    {[
                        { label: 'Browse', desc: 'Expand modules & topics in the left pane' },
                        { label: 'Select', desc: 'Click any subtopic to load its notes' },
                        { label: 'Ask AI', desc: 'Send any topic to chat with RAG context' },
                    ].map((s, i) => (
                        <div key={i} className="p-4 border border-[#1a1a1a] rounded-xl bg-[#0f0f0f]">
                            <div className="text-xs text-gray-500 uppercase tracking-widest mb-1 font-bold">{s.label}</div>
                            <div className="text-[11px] text-gray-600 leading-snug">{s.desc}</div>
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    return (
        <div ref={scrollRef} className="flex-1 overflow-y-auto custom-scrollbar relative">
            {/* Mobile sidebar toggle */}
            <button
                className="md:hidden sticky top-4 left-4 z-10 p-2 bg-[#111]/80 backdrop-blur border border-white/10 rounded-lg text-gray-400 hover:text-white ml-4 mt-4"
                onClick={() => setSidebarOpen(true)}
            >
                <Menu size={16} />
            </button>

            <div className="px-6 py-6 md:px-10 md:py-8 max-w-4xl mx-auto">
                {/* Breadcrumb */}
                <div className="flex items-center gap-2 text-[11px] text-gray-600 mb-6">
                    <span className="text-indigo-400/80">{stripExt(courseName)}</span>
                    {activeSubtopic.topicName && (
                        <>
                            <ChevronRight size={10} />
                            <span>{activeSubtopic.topicName}</span>
                        </>
                    )}
                    <ChevronRight size={10} />
                    <span className="text-gray-400">{activeSubtopic.name}</span>
                </div>

                {/* Title bar */}
                <div className="flex items-start justify-between gap-4 mb-8">
                    <div>
                        <h1 className="text-2xl font-bold text-white leading-tight">{activeSubtopic.name}</h1>
                        {activeSubtopic.topicName && (
                            <p className="text-sm text-gray-500 mt-1">{activeSubtopic.topicName}</p>
                        )}
                    </div>
                    <button
                        onClick={onAskAI}
                        className="flex-shrink-0 flex items-center gap-2 px-4 py-2 bg-indigo-600/20 hover:bg-indigo-600/35 border border-indigo-500/30 hover:border-indigo-500/60 text-indigo-300 rounded-xl text-sm font-medium transition-all"
                    >
                        <MessageSquare size={14} />
                        Ask AI
                    </button>
                </div>

                {/* Loading */}
                {loading && (
                    <div className="flex flex-col items-center justify-center py-20 gap-4 text-gray-500">
                        <Loader2 size={24} className="animate-spin text-indigo-400" />
                        {generating ? (
                            <div className="text-center space-y-1">
                                <p className="text-sm text-gray-300 font-medium">Generating lecture notes…</p>
                                <p className="text-xs text-gray-600">First time for this subtopic — using AI to create<br/>definitions, diagrams and examples. ~15 seconds.</p>
                            </div>
                        ) : (
                            <span className="text-sm">Loading lecture…</span>
                        )}
                    </div>
                )}

                {/* Error */}
                {!loading && error && (
                    <div className="flex flex-col items-center justify-center py-20 gap-3 text-red-400">
                        <AlertTriangle size={24} />
                        <p className="text-sm">{error}</p>
                    </div>
                )}

                {/* No content */}
                {!loading && !error && !markdown && (
                    <div className="flex flex-col items-center justify-center py-20 gap-4 text-gray-600">
                        <FileText size={32} className="opacity-20" />
                        <div className="text-center">
                            <p className="text-sm font-medium text-gray-500">No lecture generated yet</p>
                            <p className="text-[12px] text-gray-700 mt-1">Run the course bootstrap to generate lecture notes for this subtopic.</p>
                        </div>
                    </div>
                )}

                {/* Lecture content */}
                {!loading && !error && markdown && (
                    <div>
                        <article className="rounded-2xl border border-white/8 bg-white/2 overflow-hidden">
                            <div className="px-5 py-3 border-b border-white/7 flex items-center gap-2.5 bg-white/2">
                                <FileText size={13} className="text-indigo-400 flex-shrink-0" />
                                <span className="text-[11px] text-gray-500 uppercase tracking-wide font-semibold">
                                    Lecture · {activeSubtopic.name}
                                </span>
                                {source === 'generated' && (
                                    <span className="ml-auto text-[10px] text-emerald-400/70 bg-emerald-400/10 border border-emerald-400/20 px-2 py-0.5 rounded-full">
                                        AI-generated
                                    </span>
                                )}
                                {source === 'lecture_md' && (
                                    <span className="ml-auto text-[10px] text-indigo-400/70 bg-indigo-400/10 border border-indigo-400/20 px-2 py-0.5 rounded-full">
                                        Lecture notes
                                    </span>
                                )}
                            </div>
                            <div className="px-5 py-5">
                                <LectureMermaidMarkdown content={markdown} />
                            </div>
                        </article>

                        {/* Bottom CTA */}
                        <div className="flex items-center justify-end pt-4 pb-8 border-t border-white/8 mt-6">
                            <button
                                onClick={onAskAI}
                                className="flex items-center gap-2 px-4 py-2 bg-indigo-600/20 hover:bg-indigo-600/35 border border-indigo-500/30 text-indigo-300 rounded-xl text-sm font-medium transition-all"
                            >
                                <MessageSquare size={14} />
                                Discuss with AI
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

// ─── Course Selection Grid ─────────────────────────────────────────────────────
function CourseGrid({ onSelectCourse }) {
    const [courses, setCourses] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [search, setSearch] = useState('');
    const navigate = useNavigate();

    useEffect(() => {
        api.getSubjects()
            .then(data => setCourses(Array.isArray(data.subjects) ? data.subjects : []))
            .catch(e => setError(e.response?.data?.message || e.message || 'Failed to load courses'))
            .finally(() => setLoading(false));
    }, []);

    const filtered = courses.filter(c =>
        stripExt(c).toLowerCase().includes(search.toLowerCase())
    );

    // Palette: cycle through accent colors for variety
    const ACCENTS = [
        { bg: 'from-indigo-500/20 to-indigo-500/5', border: 'border-indigo-500/30', icon: 'text-indigo-400', badge: 'bg-indigo-500/20 text-indigo-300' },
        { bg: 'from-cyan-500/20 to-cyan-500/5',     border: 'border-cyan-500/30',   icon: 'text-cyan-400',   badge: 'bg-cyan-500/20 text-cyan-300' },
        { bg: 'from-violet-500/20 to-violet-500/5', border: 'border-violet-500/30', icon: 'text-violet-400', badge: 'bg-violet-500/20 text-violet-300' },
        { bg: 'from-emerald-500/20 to-emerald-500/5', border: 'border-emerald-500/30', icon: 'text-emerald-400', badge: 'bg-emerald-500/20 text-emerald-300' },
        { bg: 'from-amber-500/20 to-amber-500/5',   border: 'border-amber-500/30',  icon: 'text-amber-400',  badge: 'bg-amber-500/20 text-amber-300' },
        { bg: 'from-rose-500/20 to-rose-500/5',     border: 'border-rose-500/30',   icon: 'text-rose-400',   badge: 'bg-rose-500/20 text-rose-300' },
    ];

    return (
        <div className="min-h-screen bg-[#080a0e] text-white flex flex-col relative overflow-hidden">
            {/* Background radial gradient */}
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_rgba(99,102,241,0.08)_0%,_transparent_60%)] pointer-events-none" />

            {/* Back button */}
            <button
                onClick={() => navigate('/')}
                className="absolute top-6 left-6 flex items-center gap-2 text-xs font-bold text-gray-500 uppercase tracking-widest hover:text-white transition-colors z-10"
            >
                <ArrowLeft size={14} /> Dashboard
            </button>

            {/* Hero */}
            <div className="flex flex-col items-center justify-center pt-20 pb-10 px-6 text-center">
                <div className="inline-block px-3 py-1 mb-6 border border-[#1e2030] rounded-full text-[10px] uppercase tracking-widest text-gray-500 font-bold bg-[#0d0f18]">
                    Course Library
                </div>
                <h1 className="text-5xl font-serif font-medium text-white mb-4 tracking-tight">
                    Courses
                </h1>
                <p className="text-gray-400 text-base max-w-md leading-relaxed mb-8">
                    Browse admin-curated course content. Select a course to explore its complete lecture notes with AI-powered search.
                </p>

                {/* Search */}
                <div className="relative w-full max-w-md">
                    <Search size={15} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-600" />
                    <input
                        type="text"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder="Search courses…"
                        className="w-full bg-[#0f1117] border border-[#1e2030] rounded-xl pl-10 pr-4 py-3 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-indigo-500/50 transition-colors"
                    />
                    {search && (
                        <button onClick={() => setSearch('')} className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-600 hover:text-white">
                            <X size={13} />
                        </button>
                    )}
                </div>
            </div>

            {/* Course cards */}
            <div className="flex-1 px-6 pb-16 max-w-5xl mx-auto w-full">
                {loading && (
                    <div className="flex items-center justify-center py-20 gap-3 text-gray-500">
                        <Loader2 size={22} className="animate-spin text-indigo-400" />
                        <span className="text-sm">Loading courses…</span>
                    </div>
                )}

                {error && !loading && (
                    <div className="flex flex-col items-center justify-center py-20 gap-3 text-red-400">
                        <AlertTriangle size={24} />
                        <p className="text-sm">{error}</p>
                        <button
                            onClick={() => { setError(null); setLoading(true); api.getSubjects().then(d => setCourses(d.subjects || [])).catch(e => setError(e.message)).finally(() => setLoading(false)); }}
                            className="flex items-center gap-1.5 text-xs text-indigo-400 hover:text-indigo-300"
                        >
                            <RefreshCw size={12} /> Retry
                        </button>
                    </div>
                )}

                {!loading && !error && filtered.length === 0 && (
                    <div className="flex flex-col items-center justify-center py-20 gap-3 text-gray-600">
                        <BookOpen size={32} className="opacity-20" />
                        <p className="text-sm">{courses.length === 0 ? 'No courses available yet.' : 'No courses match your search.'}</p>
                    </div>
                )}

                {!loading && !error && filtered.length > 0 && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                        {filtered.map((course, i) => {
                            const accent = ACCENTS[i % ACCENTS.length];
                            const name = stripExt(course);
                            return (
                                <button
                                    key={course}
                                    onClick={() => onSelectCourse(course)}
                                    className={`group relative flex flex-col items-start p-6 rounded-2xl border ${accent.border} bg-gradient-to-br ${accent.bg} hover:scale-[1.02] hover:shadow-xl hover:shadow-black/40 transition-all duration-200 text-left`}
                                >
                                    <div className={`p-3 rounded-xl bg-white/5 mb-4 ${accent.icon}`}>
                                        <GraduationCap size={22} />
                                    </div>
                                    <h3 className="text-base font-bold text-white mb-1 leading-tight">{name}</h3>
                                    <p className="text-[12px] text-gray-500 leading-snug flex-1">
                                        Browse lecture notes, explore topics and subtopics.
                                    </p>
                                    <div className={`mt-4 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold ${accent.badge}`}>
                                        <BookOpen size={10} /> Open Course
                                    </div>
                                    {/* Arrow on hover */}
                                    <div className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <ChevronRight size={16} className={accent.icon} />
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}

// ─── Loading skeleton for course structure ─────────────────────────────────────
function StructureLoading() {
    return (
        <div className="p-4 space-y-3 animate-pulse">
            {[1, 2, 3].map(i => (
                <div key={i} className="rounded-xl border border-white/8 overflow-hidden">
                    <div className="flex items-center gap-2.5 px-3 py-3">
                        <div className="w-7 h-7 rounded-md bg-white/5" />
                        <div className="h-3 bg-white/8 rounded flex-1" />
                        <div className="w-8 h-2 bg-white/5 rounded" />
                    </div>
                </div>
            ))}
        </div>
    );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────
export default function CourseExplorerPage() {
    const navigate = useNavigate();
    const { setSelectedSubject, setInitialPromptForNewSession, setTutorMode, setTutorModeType } = useAppState();

    const [selectedCourse, setSelectedCourse] = useState(null);
    const [structure, setStructure]           = useState(null);
    const [loadingStruct, setLoadingStruct]   = useState(false);
    const [structError, setStructError]       = useState(null);
    const [activeSubtopic, setActiveSubtopic] = useState(null);
    const [sidebarOpen, setSidebarOpen]       = useState(true);

    const [quizModalOpen, setQuizModalOpen] = useState(false);
    const [quizModuleId, setQuizModuleId] = useState(null);
    const [quizModuleName, setQuizModuleName] = useState(null);

    const handleOpenQuiz = useCallback(({ moduleId = null, moduleName = null }) => {
        setQuizModuleId(moduleId);
        setQuizModuleName(moduleName);
        setQuizModalOpen(true);
    }, []);

    const handleSelectCourse = useCallback((course) => {
        setSelectedCourse(course);
        setActiveSubtopic(null);
        setStructure(null);
        setStructError(null);
        setSidebarOpen(true);

        // Activate RAG for this course in global context
        setSelectedSubject(course);

        // Load structure
        setLoadingStruct(true);
        api.getCourseStructure(course)
            .then(data => setStructure(data.curriculum || null))
            .catch(e => setStructError(e.response?.data?.message || e.message || 'Failed to load'))
            .finally(() => setLoadingStruct(false));
    }, [setSelectedSubject]);

    const handleBack = useCallback(() => {
        setSelectedCourse(null);
        setStructure(null);
        setActiveSubtopic(null);
        setSelectedSubject(null);
    }, [setSelectedSubject]);

    const handleSubtopicSelect = useCallback((sub) => {
        setActiveSubtopic(sub);
        // Close mobile overlay only (desktop sidebar stays always visible)
        setSidebarOpen(false);
    }, []);

    const handleAskAI = useCallback(() => {
        // Navigate to tutor mode with prompt pre-filled; RAG is already set via setSelectedSubject
        const prompt = activeSubtopic
            ? `Explain "${activeSubtopic.name}" from ${stripExt(selectedCourse)}`
            : `Teach me about ${stripExt(selectedCourse)}`;
        setInitialPromptForNewSession(prompt);
        setTutorMode(true);
        setTutorModeType('structured');
        navigate('/tutor');
    }, [activeSubtopic, selectedCourse, setInitialPromptForNewSession, setTutorMode, setTutorModeType, navigate]);

    // ── Phase 1: No course selected → grid ──
    if (!selectedCourse) {
        return <CourseGrid onSelectCourse={handleSelectCourse} />;
    }

    // ── Sidebar content (shared between desktop + mobile) ──
    const sidebarContent = loadingStruct ? (
        <div
            className="flex flex-col h-full"
            style={{ background: 'linear-gradient(180deg, #0d0f14 0%, #0a0c10 100%)', borderRight: '1px solid rgba(255,255,255,0.07)' }}
        >
            <div className="flex items-center gap-2.5 px-4 py-3.5 border-b border-white/7">
                <button onClick={handleBack} className="p-1.5 rounded-lg text-gray-500 hover:text-white hover:bg-white/8">
                    <ArrowLeft size={15} />
                </button>
                <div className="flex-1">
                    <p className="text-[10px] text-gray-600 uppercase tracking-widest font-bold">Course</p>
                    <div className="h-3 bg-white/10 rounded w-32 mt-1 animate-pulse" />
                </div>
            </div>
            <StructureLoading />
        </div>
    ) : structError ? (
        <div
            className="flex flex-col h-full"
            style={{ background: 'linear-gradient(180deg, #0d0f14 0%, #0a0c10 100%)', borderRight: '1px solid rgba(255,255,255,0.07)' }}
        >
            <div className="flex items-center gap-2.5 px-4 py-3.5 border-b border-white/7">
                <button onClick={handleBack} className="p-1.5 rounded-lg text-gray-500 hover:text-white hover:bg-white/8">
                    <ArrowLeft size={15} />
                </button>
                <p className="text-sm font-bold text-white">{stripExt(selectedCourse)}</p>
            </div>
            <div className="flex flex-col items-center justify-center flex-1 gap-3 text-red-400 px-6 text-center">
                <AlertTriangle size={22} />
                <p className="text-xs">{structError}</p>
                <button onClick={() => handleSelectCourse(selectedCourse)} className="text-[11px] text-indigo-400 hover:underline flex items-center gap-1">
                    <RefreshCw size={10} /> Retry
                </button>
            </div>
        </div>
    ) : (
        <CourseSidebar
            courseName={selectedCourse}
            structure={structure}
            activeSubtopic={activeSubtopic}
            onSubtopicSelect={handleSubtopicSelect}
            onBack={handleBack}
            sidebarOpen={sidebarOpen}
            setSidebarOpen={setSidebarOpen}
            onTakeQuiz={handleOpenQuiz}
        />
    );

    // ── Phase 2: Course selected → split pane ──
    return (
        <div
            className="flex h-screen w-full overflow-hidden text-white"
            style={{ background: '#080a0e' }}
        >
            {/* ── Desktop sidebar — always visible, never collapses ── */}
            <div className="hidden md:flex flex-shrink-0 h-full overflow-hidden" style={{ width: '288px' }}>
                {sidebarContent}
            </div>

            {/* ── Mobile sidebar — overlay, toggled by hamburger ── */}
            {sidebarOpen && (
                <>
                    <div
                        className="fixed inset-0 bg-black/60 z-30 md:hidden"
                        onClick={() => setSidebarOpen(false)}
                    />
                    <div
                        className="fixed top-0 left-0 bottom-0 z-40 md:hidden"
                        style={{ width: '85vw', maxWidth: '320px' }}
                    >
                        {sidebarContent}
                    </div>
                </>
            )}

            {/* ── Right — content pane ── */}
            <div className="flex-1 flex flex-col h-full overflow-hidden min-w-0">
                {/* Top bar */}
                <div
                    className="flex items-center gap-3 px-4 py-3 border-b flex-shrink-0"
                    style={{ borderColor: 'rgba(255,255,255,0.07)', background: '#0a0c10' }}
                >
                    {/* Mobile only: hamburger to open sidebar overlay */}
                    <button
                        className="md:hidden p-1.5 rounded-lg text-gray-500 hover:text-white hover:bg-white/8 transition-all"
                        onClick={() => setSidebarOpen(true)}
                    >
                        <Menu size={16} />
                    </button>

                    {/* Desktop: Back to courses */}
                    <button
                        onClick={handleBack}
                        className="hidden md:flex items-center gap-1.5 text-xs text-gray-500 hover:text-white transition-colors font-medium"
                    >
                        <ArrowLeft size={13} /> All Courses
                    </button>
                    <div className="hidden md:block w-px h-4 bg-white/10" />

                    <div className="flex-1 flex items-center gap-2 min-w-0">
                        <GraduationCap size={14} className="text-indigo-400 flex-shrink-0" />
                        <span className="text-sm font-semibold text-white truncate">{stripExt(selectedCourse)}</span>
                        {activeSubtopic && (
                            <>
                                <ChevronRight size={12} className="text-gray-600 flex-shrink-0" />
                                <span className="text-sm text-gray-400 truncate">{activeSubtopic.name}</span>
                            </>
                        )}
                    </div>

                    {/* RAG indicator + Ask AI */}
                    <div className="flex items-center gap-3 flex-shrink-0">
                        <div className="hidden sm:flex items-center gap-1.5 text-[11px] text-gray-600">
                            <div className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-pulse" />
                            RAG active
                        </div>
                        <button
                            onClick={() => handleOpenQuiz({ moduleId: null, moduleName: null })}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-600/20 hover:bg-purple-600/35 border border-purple-500/30 text-purple-300 rounded-lg text-xs font-semibold transition-all animate-fade-in"
                        >
                            <Brain size={12} />
                            Quiz
                        </button>
                        <button
                            onClick={handleAskAI}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600/20 hover:bg-indigo-600/35 border border-indigo-500/30 text-indigo-300 rounded-lg text-xs font-semibold transition-all"
                        >
                            <MessageSquare size={12} />
                            Ask AI
                        </button>
                    </div>
                </div>

                {/* Content */}
                <ContentPane
                    courseName={selectedCourse}
                    activeSubtopic={activeSubtopic}
                    onAskAI={handleAskAI}
                    sidebarOpen={sidebarOpen}
                    setSidebarOpen={setSidebarOpen}
                />
            </div>
            
            <CourseQuizModal
                isOpen={quizModalOpen}
                onClose={() => setQuizModalOpen(false)}
                courseName={selectedCourse}
                moduleId={quizModuleId}
                moduleName={quizModuleName}
            />
        </div>
    );
}

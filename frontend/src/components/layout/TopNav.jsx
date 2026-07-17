// frontend/src/components/layout/TopNav.jsx
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAppState } from '../../contexts/AppStateContext';

import LLMSelectionModal from './LLMSelectionModal.jsx';
import ProfileSettingsModal from '../profile/ProfileSettingsModal.jsx';
import {
    LogOut,
    User,
    MessageSquare,
    Settings,
    Cpu,
    Zap,
    ServerCrash,
    Server,
    Wrench,
    GraduationCap,
    Brain,
    Sparkles,
    Type
} from 'lucide-react';
import ToolsModal from '../tools/ToolsModal.jsx';
import LevelBadge from '../gamification/LevelBadge.jsx';
import RankBadge from '../gamification/RankBadge.jsx';
import XPProgressModal from '../gamification/XPProgressModal.jsx';
import { useUserLevel } from '../../hooks/useUserLevel.jsx';
import FeedbackWidget from './FeedbackWidget.jsx';

// ─── Text Size Control ────────────────────────────────────────────────────────
// Eight steps: 2 below default · default (17px) · 5 above default
// Persisted in localStorage so the preference survives page refresh.

const FONT_SIZES = [
    { size: '13px', title: 'Compact (smallest)' },
    { size: '15px', title: 'Small'               },
    { size: '17px', title: 'Default'             },  // ← index 2
    { size: '19px', title: 'Large'               },
    { size: '21px', title: 'Larger'              },
    { size: '23px', title: 'Extra large'         },
    { size: '25px', title: 'Huge'                },
    { size: '27px', title: 'Maximum'             },
];
const FS_STORAGE_KEY  = 'imentor-font-base';
const FS_DEFAULT      = '17px';
const FS_DEFAULT_IDX  = 2;  // index of FS_DEFAULT in FONT_SIZES

function applyFontSize(size) {
    document.documentElement.style.setProperty('--font-base', size);
}

function TextSizeControl() {
    const [sizeIndex, setSizeIndex] = useState(() => {
        const saved = localStorage.getItem(FS_STORAGE_KEY);
        // Migrate: if user had old default (15px) saved, upgrade to new default (17px)
        if (!saved || saved === '15px') return FS_DEFAULT_IDX;
        const idx = FONT_SIZES.findIndex(f => f.size === saved);
        return idx !== -1 ? idx : FS_DEFAULT_IDX;
    });

    // Apply on mount (restores preference after page load)
    useEffect(() => {
        applyFontSize(FONT_SIZES[sizeIndex].size);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const decrease = useCallback(() => {
        setSizeIndex(prev => {
            const next = Math.max(0, prev - 1);
            applyFontSize(FONT_SIZES[next].size);
            localStorage.setItem(FS_STORAGE_KEY, FONT_SIZES[next].size);
            return next;
        });
    }, []);

    const resetDefault = useCallback(() => {
        setSizeIndex(FS_DEFAULT_IDX);
        applyFontSize(FS_DEFAULT);
        localStorage.setItem(FS_STORAGE_KEY, FS_DEFAULT);
    }, []);

    const increase = useCallback(() => {
        setSizeIndex(prev => {
            const next = Math.min(FONT_SIZES.length - 1, prev + 1);
            applyFontSize(FONT_SIZES[next].size);
            localStorage.setItem(FS_STORAGE_KEY, FONT_SIZES[next].size);
            return next;
        });
    }, []);

    const btnBase = {
        lineHeight: 1,
        padding: '4px 6px',
        borderRadius: '3px',
        border: '1px solid transparent',
        background: 'transparent',
        cursor: 'pointer',
        transition: 'color 0.15s, background 0.15s, border-color 0.15s',
        minWidth: '24px',
        textAlign: 'center',
        userSelect: 'none',
    };

    return (
        <div
            className="flex items-center gap-px"
            role="group"
            aria-label="Text size"
            title="Adjust text size for readability"
        >
            <Type
                size={14}
                style={{ color: 'var(--vs-text-dim)' }}
                aria-hidden="true"
                className="mr-1 flex-shrink-0"
            />
            {/* Decrease */}
            <button
                onClick={decrease}
                disabled={sizeIndex === 0}
                title={sizeIndex === 0 ? 'Smallest size reached' : `Smaller — ${FONT_SIZES[sizeIndex - 1]?.title}`}
                aria-label="Decrease text size"
                style={{
                    ...btnBase,
                    fontSize: '11px',
                    fontWeight: 500,
                    color: sizeIndex === 0 ? 'var(--vs-text-dim)' : 'var(--vs-text-lo)',
                    opacity: sizeIndex === 0 ? 0.4 : 1,
                }}
                onMouseEnter={e => { if (sizeIndex > 0) e.currentTarget.style.color = 'var(--vs-text)'; }}
                onMouseLeave={e => { if (sizeIndex > 0) e.currentTarget.style.color = 'var(--vs-text-lo)'; }}
            >A</button>
            {/* Reset to default */}
            <button
                onClick={resetDefault}
                title={`Reset to default (${FONT_SIZES[FS_DEFAULT_IDX]?.title})`}
                aria-label="Reset text size to default"
                style={{
                    ...btnBase,
                    fontSize: '14px',
                    fontWeight: sizeIndex === FS_DEFAULT_IDX ? 700 : 500,
                    color: sizeIndex === FS_DEFAULT_IDX ? 'var(--vs-text)' : 'var(--vs-text-lo)',
                    border: sizeIndex === FS_DEFAULT_IDX ? '1px solid var(--vs-border-hi)' : '1px solid transparent',
                    background: sizeIndex === FS_DEFAULT_IDX ? 'var(--vs-active)' : 'transparent',
                }}
                onMouseEnter={e => { e.currentTarget.style.color = 'var(--vs-text)'; }}
                onMouseLeave={e => { e.currentTarget.style.color = sizeIndex === FS_DEFAULT_IDX ? 'var(--vs-text)' : 'var(--vs-text-lo)'; }}
            >A</button>
            {/* Increase */}
            <button
                onClick={increase}
                disabled={sizeIndex === FONT_SIZES.length - 1}
                title={sizeIndex === FONT_SIZES.length - 1 ? 'Largest size reached' : `Larger — ${FONT_SIZES[sizeIndex + 1]?.title}`}
                aria-label="Increase text size"
                style={{
                    ...btnBase,
                    fontSize: '18px',
                    fontWeight: 600,
                    color: sizeIndex === FONT_SIZES.length - 1 ? 'var(--vs-text-dim)' : 'var(--vs-text-lo)',
                    opacity: sizeIndex === FONT_SIZES.length - 1 ? 0.4 : 1,
                }}
                onMouseEnter={e => { if (sizeIndex < FONT_SIZES.length - 1) e.currentTarget.style.color = 'var(--vs-text)'; }}
                onMouseLeave={e => { if (sizeIndex < FONT_SIZES.length - 1) e.currentTarget.style.color = 'var(--vs-text-lo)'; }}
            >A</button>
        </div>
    );
}

// ─── TopNav ───────────────────────────────────────────────────────────────────

function TopNav({
    user: authUser,
    onLogout,
    onNewChat,
    orchestratorStatus,
    isChatProcessing,
    xpRefreshCounter = 0
}) {
    const [isLLMModalOpen, setIsLLMModalOpen] = useState(false);
    const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
    const [isToolsModalOpen, setIsToolsModalOpen] = useState(false);
    const [isXPModalOpen, setIsXPModalOpen] = useState(false);

    const navigate = useNavigate();
    const { level, totalXP, loading: levelLoading } = useUserLevel(null, xpRefreshCounter);
    const { selectedLLM, switchLLM, tutorMode } = useAppState();

    const handleEnableTutorMode = () => navigate('/tutor');

    const [isProfileDropdownOpen, setIsProfileDropdownOpen] = useState(false);
    const profileDropdownRef = useRef(null);

    const StatusIndicator = useMemo(() => {
        if (!orchestratorStatus) {
            return (
                <div
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ background: 'var(--vs-border-hi)' }}
                    title="Status unavailable"
                />
            );
        }
        if (orchestratorStatus.status === 'ok') {
            return (
                <Zap
                    size={20}
                    style={{ color: 'var(--vs-text-lo)' }}
                    title={orchestratorStatus.message}
                />
            );
        }
        if (orchestratorStatus.status === 'loading') {
            return (
                <div
                    className="animate-spin rounded-full w-5 h-5 border-t border-b"
                    style={{ borderColor: 'var(--vs-text-dim)' }}
                    title="Connecting..."
                />
            );
        }
        return (
            <ServerCrash
                size={20}
                style={{ color: 'var(--vs-text-dim)' }}
                title={orchestratorStatus.message}
            />
        );
    }, [orchestratorStatus]);

    useEffect(() => {
        const handler = (e) => {
            if (profileDropdownRef.current && !profileDropdownRef.current.contains(e.target)) {
                setIsProfileDropdownOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    // Shared pill style — VS Code activity bar button aesthetic
    const pillCls = `
        inline-flex items-center gap-1.5
        px-3 py-1.5
        text-xs font-medium tracking-wide
        rounded-vs
        border
        transition-colors duration-150
        select-none
        cursor-pointer
    `;
    const pillNormal = `
        ${pillCls}
        text-[color:var(--vs-text-lo)]
        bg-[color:var(--vs-sidebar)]
        border-[color:var(--vs-border)]
        hover:bg-[color:var(--vs-surface)]
        hover:text-[color:var(--vs-text)]
        hover:border-[color:var(--vs-border-hi)]
    `;
    const pillDisabled = 'opacity-40 cursor-not-allowed';

    return (
        <>
            {/* ── Nav bar ─────────────────────────────────────────────────── */}
            <nav
                className="fixed top-0 left-0 right-0 z-40 flex items-center justify-between px-3 sm:px-5 h-11"
                style={{
                    background:   'var(--vs-sidebar)',
                    borderBottom: '1px solid var(--vs-border)',
                    boxShadow:    '0 1px 0 rgba(0,0,0,0.3)',
                }}
            >
                {/* Logo */}
                <Link
                    to="/"
                    className="flex items-center gap-2 flex-shrink-0"
                    style={{ textDecoration: 'none' }}
                >
                    <Server
                        size={16}
                        style={{ color: 'var(--vs-text-lo)' }}
                    />
                    <span
                        className="hidden sm:inline text-sm font-semibold tracking-tight"
                        style={{ color: 'var(--vs-text)', letterSpacing: '-0.01em' }}
                    >
                        iMentor
                    </span>
                </Link>

                {/* Center actions — hidden in Tutor mode */}
                {!tutorMode && (
                    <div className="flex-1 flex justify-center px-4">
                        <div className="flex items-center gap-1.5">

                            <button
                                onClick={onNewChat}
                                disabled={isChatProcessing}
                                className={`${pillNormal} ${isChatProcessing ? pillDisabled : ''}`}
                            >
                                <MessageSquare size={12} />
                                <span className="hidden sm:inline">New Chat</span>
                            </button>

                            <Link
                                to="/study-plan"
                                className={`hidden md:inline-flex ${pillNormal}`}
                            >
                                <GraduationCap size={12} />
                                <span>Study Plan</span>
                            </Link>

                            <button
                                onClick={() => setIsToolsModalOpen(true)}
                                className={`hidden md:inline-flex ${pillNormal}`}
                            >
                                <Wrench size={12} />
                                <span>Tools</span>
                            </button>

                            <button
                                onClick={() => setIsLLMModalOpen(true)}
                                className={`hidden md:inline-flex ${pillNormal}`}
                            >
                                <Cpu size={12} />
                                <span>
                                    {selectedLLM === 'local_llm'
                                        ? 'Local LLM'
                                        : selectedLLM?.toUpperCase()}
                                </span>
                            </button>

                        </div>
                    </div>
                )}

                {/* Right controls */}
                <div className="flex items-center gap-4 flex-shrink-0">

                    {/* Orchestrator status dot */}
                    {StatusIndicator}

                    {/* ── Text size control — hidden on mobile (tap targets too small) */}
                    <div className="hidden md:flex">
                        <TextSizeControl />
                    </div>

                    {/* User / profile area */}
                    <div className="relative" ref={profileDropdownRef}>
                        <div className="flex items-center gap-2">

                            {/* XP rank badge (small) */}
                            {!levelLoading && level && (
                                <div className="flex items-center gap-1.5" style={{ cursor: 'pointer' }} onClick={() => setIsXPModalOpen(true)}>
                                    <RankBadge
                                        level={level}
                                        size="md"
                                        showLabel={false}
                                    />
                                    <span style={{
                                        fontSize: '12px',
                                        fontWeight: 700,
                                        color: '#6bcf7f',
                                        letterSpacing: '0.03em',
                                        whiteSpace: 'nowrap',
                                        textShadow: '0 0 8px rgba(107,207,127,0.3)',
                                    }}>
                                        {totalXP.toLocaleString()} XP
                                    </span>
                                </div>
                            )}

                            {/* Product feedback — bug / enhancement report */}
                            <FeedbackWidget />
                            <button
                                onClick={() => setIsProfileDropdownOpen(p => !p)}
                                className="relative flex items-center justify-center w-10 h-10 rounded-full transition-colors duration-150"
                                style={{
                                    background:   'var(--vs-surface)',
                                    border:       '1px solid var(--vs-border-hi)',
                                    color:        'var(--vs-text)',
                                }}
                                aria-label="Open user menu"
                                aria-expanded={isProfileDropdownOpen}
                            >
                                <User size={20} />
                                {!levelLoading && level && (
                                    <div className="absolute -bottom-1 -right-1">
                                        <LevelBadge level={level} size="xs" />
                                    </div>
                                )}
                            </button>
                        </div>

                        {/* Dropdown */}
                        {isProfileDropdownOpen && (
                            <div
                                className="absolute right-0 mt-1.5 w-52 z-50 animate-motion-scale-in-sm"
                                style={{
                                    background:   'var(--vs-panel)',
                                    border:       '1px solid var(--vs-border-hi)',
                                    borderRadius: '4px',
                                    boxShadow:    '0 8px 24px rgba(0,0,0,0.5)',
                                    overflow:     'hidden',
                                }}
                                role="menu"
                            >
                                {/* Header */}
                                <div
                                    className="px-3 py-2.5"
                                    style={{
                                        borderBottom: '1px solid var(--vs-border)',
                                        fontSize: '0.75rem',
                                    }}
                                >
                                    <div style={{ color: 'var(--vs-text-dim)', marginBottom: '1px' }}>
                                        Signed in as
                                    </div>
                                    <div
                                        className="font-semibold truncate"
                                        style={{ color: 'var(--vs-text)' }}
                                    >
                                        {authUser?.username}
                                    </div>
                                </div>

                                {/* Menu items */}
                                {[
                                    {
                                        type: 'link',
                                        to: '/learning-profile',
                                        icon: Brain,
                                        label: 'Learning Memory',
                                    },
                                    {
                                        type: 'button',
                                        onClick: () => { setIsProfileModalOpen(true); setIsProfileDropdownOpen(false); },
                                        icon: Settings,
                                        label: 'Profile Settings',
                                    },
                                    {
                                        type: 'button',
                                        onClick: () => { onLogout(); setIsProfileDropdownOpen(false); },
                                        icon: LogOut,
                                        label: 'Logout',
                                    },
                                ].map((item, idx) => {
                                    const itemCls = `
                                        flex items-center gap-2.5 w-full
                                        px-3 py-2 text-left text-xs
                                        transition-colors duration-100 cursor-pointer
                                    `;
                                    const itemStyle = {
                                        color:      'var(--vs-text-lo)',
                                        background: 'transparent',
                                        border:     'none',
                                        textDecoration: 'none',
                                    };
                                    const Icon = item.icon;

                                    if (item.type === 'link') {
                                        return (
                                            <Link
                                                key={idx}
                                                to={item.to}
                                                className={itemCls}
                                                style={itemStyle}
                                                role="menuitem"
                                                onClick={() => setIsProfileDropdownOpen(false)}
                                                onMouseEnter={e => {
                                                    e.currentTarget.style.background = 'var(--vs-hover)';
                                                    e.currentTarget.style.color      = 'var(--vs-text)';
                                                }}
                                                onMouseLeave={e => {
                                                    e.currentTarget.style.background = 'transparent';
                                                    e.currentTarget.style.color      = 'var(--vs-text-lo)';
                                                }}
                                            >
                                                <Icon size={13} />
                                                {item.label}
                                            </Link>
                                        );
                                    }
                                    return (
                                        <button
                                            key={idx}
                                            onClick={item.onClick}
                                            className={itemCls}
                                            style={itemStyle}
                                            role="menuitem"
                                            onMouseEnter={e => {
                                                e.currentTarget.style.background = 'var(--vs-hover)';
                                                e.currentTarget.style.color      = 'var(--vs-text)';
                                            }}
                                            onMouseLeave={e => {
                                                e.currentTarget.style.background = 'transparent';
                                                e.currentTarget.style.color      = 'var(--vs-text-lo)';
                                            }}
                                        >
                                            <Icon size={13} />
                                            {item.label}
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>
            </nav>

            {/* ── Modals ──────────────────────────────────────────────────── */}
            <LLMSelectionModal
                isOpen={isLLMModalOpen}
                onClose={() => setIsLLMModalOpen(false)}
                currentLLM={selectedLLM}
                onSelectLLM={(llm) => { switchLLM(llm); setIsLLMModalOpen(false); }}
            />
            <ProfileSettingsModal
                isOpen={isProfileModalOpen}
                onClose={() => setIsProfileModalOpen(false)}
            />
            <ToolsModal
                isOpen={isToolsModalOpen}
                onClose={() => setIsToolsModalOpen(false)}
                onEnableTutorMode={handleEnableTutorMode}
            />
            <XPProgressModal
                isOpen={isXPModalOpen}
                onClose={() => setIsXPModalOpen(false)}
                level={level}
                refreshCounter={xpRefreshCounter}
            />
        </>
    );
}

export default TopNav;

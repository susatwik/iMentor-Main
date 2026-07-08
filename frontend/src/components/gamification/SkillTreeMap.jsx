import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import Animate from '../core/Animate.jsx';
import {
    Lock, Unlock, CheckCircle2, Zap, TrendingUp, ChevronRight,
    BarChart3, Eye, EyeOff, MapPin, AlertCircle, Sparkles, Target, Star,
    MessageCircle, Brain
} from 'lucide-react';
import axios from 'axios';
import toast from 'react-hot-toast';
import SkillAssessmentModal from './SkillAssessmentModal';
import NodeTutorChat from './NodeTutorChat';
import NodeAssessmentModal from './NodeAssessmentModal';

// ═══════════════════════════════════════════════════════════════════════════
// PREMIUM SKILL TREE MAP - GAME-LIKE PROGRESSION UI
// ═══════════════════════════════════════════════════════════════════════════

const SkillTreeMap = () => {
    const [searchParams] = useSearchParams();
    const treeId = searchParams.get('treeId');

    const canvasRef = useRef(null);
    const containerRef = useRef(null);
    const [skillTree, setSkillTree] = useState([]);
    const [selectedSkill, setSelectedSkill] = useState(null);
    const [loading, setLoading] = useState(true);
    const [hoveredSkill, setHoveredSkill] = useState(null);
    const [viewMode, setViewMode] = useState('fog');
    const [zoomLevel, setZoomLevel] = useState(1);
    const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
    const [isDragging, setIsDragging] = useState(false);
    const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
    const [showAssessment, setShowAssessment] = useState(false);
    const [showTutor, setShowTutor] = useState(false);
    const [showNodeAssessment, setShowNodeAssessment] = useState(false);
    const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

    // Refs for animation loop
    const skillTreeRef = useRef(skillTree);
    const zoomLevelRef = useRef(zoomLevel);
    const panOffsetRef = useRef(panOffset);
    const starsRef = useRef([]);
    const particlesRef = useRef([]);
    const animationFrameRef = useRef();
    const timeRef = useRef(0);
    const viewModeRef = useRef(viewMode);

    useEffect(() => { skillTreeRef.current = skillTree; }, [skillTree]);
    useEffect(() => { zoomLevelRef.current = zoomLevel; }, [zoomLevel]);
    useEffect(() => { panOffsetRef.current = panOffset; }, [panOffset]);
    useEffect(() => { viewModeRef.current = viewMode; }, [viewMode]);

    // Fetch skill tree data
    useEffect(() => {
        fetchSkillTree();
    }, []);

    const fetchSkillTree = async () => {
        try {
            const token = localStorage.getItem('authToken');
            const response = await axios.get(
                `${import.meta.env.VITE_API_BASE_URL}/gamification/skill-tree`,
                { headers: { Authorization: `Bearer ${token}` } }
            );
            setSkillTree(response.data.skillTree || []);
            setLoading(false);
        } catch (error) {
            console.error('[SkillTreeMap] Error fetching skill tree:', error);
            toast.error('Failed to load skill tree');
            setLoading(false);
        }
    };

    // ═══════════════════════════════════════════════════════════════════════
    // NODE VISUAL SYSTEM - PREMIUM GAME-LIKE STYLING
    // ═══════════════════════════════════════════════════════════════════════
    const getNodeVisuals = (skill) => {
        const isCurrent = skill.status === 'unlocked' && skill.masteryPercentage < skill.masteryThreshold;

        const baseColors = {
            locked: {
                bg: 'rgba(20, 20, 25, 0.95)',
                border: 'rgba(55, 55, 65, 0.6)',
                displayBg: 'radial-gradient(circle at 30% 30%, rgba(40, 40, 50, 0.9), rgba(15, 15, 20, 0.95))',
                text: '#4a4a55',
                glow: 'transparent',
                innerGlow: 'transparent',
                shadow: '0 4px 20px rgba(0, 0, 0, 0.5)',
                blur: true
            },
            unlocked: {
                bg: 'rgba(30, 32, 40, 0.95)',
                border: 'rgba(130, 135, 155, 0.7)',
                displayBg: 'radial-gradient(circle at 30% 30%, rgba(60, 65, 80, 0.9), rgba(25, 28, 35, 0.95))',
                text: '#e8e8f0',
                glow: 'rgba(180, 190, 220, 0.15)',
                innerGlow: 'rgba(150, 160, 190, 0.1)',
                shadow: '0 4px 25px rgba(100, 110, 140, 0.2), 0 0 40px rgba(120, 130, 160, 0.1)'
            },
            current: {
                bg: 'rgba(35, 40, 55, 0.95)',
                border: 'rgba(100, 200, 200, 0.8)',
                displayBg: 'radial-gradient(circle at 30% 30%, rgba(45, 55, 75, 0.95), rgba(25, 30, 40, 0.95))',
                text: '#ffffff',
                glow: 'rgba(80, 180, 180, 0.4)',
                innerGlow: 'rgba(80, 180, 180, 0.2)',
                shadow: '0 0 30px rgba(80, 180, 180, 0.3), 0 0 60px rgba(80, 180, 180, 0.15), 0 4px 20px rgba(0, 0, 0, 0.4)',
                pulse: true
            },
            mastered: {
                bg: 'rgba(255, 255, 255, 0.98)',
                border: 'rgba(255, 255, 255, 1)',
                displayBg: 'radial-gradient(circle at 30% 30%, rgba(255, 255, 255, 1), rgba(220, 225, 235, 0.95))',
                text: '#0a0a0a',
                glow: 'rgba(255, 255, 255, 0.6)',
                innerGlow: 'rgba(255, 255, 255, 0.3)',
                shadow: '0 0 40px rgba(255, 255, 255, 0.4), 0 0 80px rgba(255, 255, 255, 0.2), 0 4px 20px rgba(0, 0, 0, 0.3)',
                shine: true
            }
        };

        let state = skill.status === 'mastered' ? 'mastered' :
            isCurrent ? 'current' :
                skill.status === 'unlocked' ? 'unlocked' : 'locked';

        const visuals = baseColors[state];

        const isFogMode = viewMode === 'fog';
        const lockedOpacity = isFogMode ? 0.12 : 0.6;

        return {
            ...visuals,
            state,
            opacity: skill.status === 'locked' ? lockedOpacity : 1,
            scale: hoveredSkill === skill.skillId ? 1.12 : 1,
            background: visuals.displayBg,
            boxShadow: hoveredSkill === skill.skillId
                ? `0 0 50px ${visuals.glow}, 0 0 100px ${visuals.glow}, ${visuals.shadow}`
                : visuals.shadow,
            isFogHidden: isFogMode && skill.status === 'locked'
        };
    };

    // Mouse tracking for subtle parallax effects
    const handleMouseMove = (e) => {
        if (isDragging) {
            setPanOffset({
                x: e.clientX - dragStart.x,
                y: e.clientY - dragStart.y
            });
        }
        const rect = containerRef.current?.getBoundingClientRect();
        if (rect) {
            setMousePos({
                x: (e.clientX - rect.left) / rect.width,
                y: (e.clientY - rect.top) / rect.height
            });
        }
    };

    // Handle zoom
    const handleWheel = (e) => {
        e.preventDefault();
        const newZoom = e.deltaY < 0 ? zoomLevel * 1.1 : zoomLevel / 1.1;
        setZoomLevel(Math.max(0.5, Math.min(3, newZoom)));
    };

    // Handle pan
    const handleMouseDown = (e) => {
        if (e.button === 2) {
            setIsDragging(true);
            setDragStart({ x: e.clientX - panOffset.x, y: e.clientY - panOffset.y });
        }
    };

    const handleMouseUp = () => {
        setIsDragging(false);
    };

    // Calculate node position
    const getNodePosition = (skill) => {
        const canvasWidth = canvasRef.current?.clientWidth || 1000;
        const canvasHeight = canvasRef.current?.clientHeight || 600;
        const x = (skill.position.x / 100) * canvasWidth * zoomLevel + panOffset.x;
        const y = (skill.position.y / 100) * canvasHeight * zoomLevel + panOffset.y;
        return { x, y };
    };

    // ═══════════════════════════════════════════════════════════════════════
    // CANVAS RENDERING - PREMIUM BACKGROUND WITH DEPTH
    // ═══════════════════════════════════════════════════════════════════════

    // Draw rich gradient background with nebula-like clouds
    const drawBackground = (ctx, width, height, time) => {
        // Base gradient - deeper and richer
        const gradient = ctx.createLinearGradient(0, 0, width, height);
        gradient.addColorStop(0, '#0a0c10');
        gradient.addColorStop(0.3, '#0f1218');
        gradient.addColorStop(0.5, '#141820');
        gradient.addColorStop(0.7, '#0d1015');
        gradient.addColorStop(1, '#08090c');

        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);

        // Animated nebula clouds (grey/white)
        const drawNebula = (cx, cy, radius, opacity, phase) => {
            const nebulaGradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
            const pulse = Math.sin(time * 0.0003 + phase) * 0.3 + 0.7;
            nebulaGradient.addColorStop(0, `rgba(60, 65, 80, ${opacity * pulse * 0.4})`);
            nebulaGradient.addColorStop(0.3, `rgba(45, 50, 65, ${opacity * pulse * 0.25})`);
            nebulaGradient.addColorStop(0.6, `rgba(35, 40, 55, ${opacity * pulse * 0.15})`);
            nebulaGradient.addColorStop(1, 'transparent');
            ctx.fillStyle = nebulaGradient;
            ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
        };

        // Multiple nebula clouds at different positions
        drawNebula(width * 0.2, height * 0.3, width * 0.4, 0.6, 0);
        drawNebula(width * 0.8, height * 0.2, width * 0.35, 0.5, 1.5);
        drawNebula(width * 0.5, height * 0.7, width * 0.5, 0.55, 3);
        drawNebula(width * 0.9, height * 0.8, width * 0.3, 0.4, 4.5);
        drawNebula(width * 0.1, height * 0.9, width * 0.25, 0.35, 2);

        // Light pillars / god rays from top
        const drawLightPillar = (x, pillarWidth, intensity, phase) => {
            const pillarGradient = ctx.createLinearGradient(x, 0, x, height * 0.8);
            const flicker = Math.sin(time * 0.001 + phase) * 0.2 + 0.8;
            pillarGradient.addColorStop(0, `rgba(120, 125, 140, ${intensity * flicker * 0.15})`);
            pillarGradient.addColorStop(0.3, `rgba(90, 95, 110, ${intensity * flicker * 0.08})`);
            pillarGradient.addColorStop(0.7, `rgba(60, 65, 80, ${intensity * flicker * 0.03})`);
            pillarGradient.addColorStop(1, 'transparent');

            ctx.fillStyle = pillarGradient;
            ctx.beginPath();
            ctx.moveTo(x - pillarWidth / 2, 0);
            ctx.lineTo(x + pillarWidth / 2, 0);
            ctx.lineTo(x + pillarWidth * 1.5, height * 0.8);
            ctx.lineTo(x - pillarWidth * 1.5, height * 0.8);
            ctx.closePath();
            ctx.fill();
        };

        // Multiple light pillars
        drawLightPillar(width * 0.15, 60, 0.8, 0);
        drawLightPillar(width * 0.4, 80, 0.6, 2);
        drawLightPillar(width * 0.65, 50, 0.7, 4);
        drawLightPillar(width * 0.85, 70, 0.5, 1);

        // Central glow - focal point
        const centerGlow = ctx.createRadialGradient(
            width * 0.5, height * 0.4, 0,
            width * 0.5, height * 0.4, Math.max(width, height) * 0.5
        );
        const centerPulse = Math.sin(time * 0.0005) * 0.1 + 0.9;
        centerGlow.addColorStop(0, `rgba(80, 85, 100, ${0.12 * centerPulse})`);
        centerGlow.addColorStop(0.3, `rgba(55, 60, 75, ${0.08 * centerPulse})`);
        centerGlow.addColorStop(0.6, `rgba(35, 40, 55, ${0.04 * centerPulse})`);
        centerGlow.addColorStop(1, 'transparent');
        ctx.fillStyle = centerGlow;
        ctx.fillRect(0, 0, width, height);

        // Deep vignette for focus
        const vignette = ctx.createRadialGradient(
            width * 0.5, height * 0.5, height * 0.15,
            width * 0.5, height * 0.5, Math.max(width, height) * 0.85
        );
        vignette.addColorStop(0, 'transparent');
        vignette.addColorStop(0.5, 'rgba(0, 0, 0, 0.15)');
        vignette.addColorStop(0.8, 'rgba(0, 0, 0, 0.4)');
        vignette.addColorStop(1, 'rgba(0, 0, 0, 0.7)');
        ctx.fillStyle = vignette;
        ctx.fillRect(0, 0, width, height);
    };

    // Note: Noise overlay removed for performance - nebulas provide texture

    // Draw enhanced grid with glow
    const drawGrid = (ctx, width, height, currentPan, currentZoom, time) => {
        const gridSize = 50 * currentZoom;
        const offsetX = currentPan.x % gridSize;
        const offsetY = currentPan.y % gridSize;

        // Subtle gradient on grid lines
        ctx.strokeStyle = 'rgba(50, 55, 70, 0.2)';
        ctx.lineWidth = 1;

        ctx.beginPath();
        for (let i = offsetX; i < width; i += gridSize) {
            ctx.moveTo(i, 0);
            ctx.lineTo(i, height);
        }
        for (let i = offsetY; i < height; i += gridSize) {
            ctx.moveTo(0, i);
            ctx.lineTo(width, i);
        }
        ctx.stroke();

        // Larger accent grid
        const largeGridSize = gridSize * 5;
        const largeOffsetX = currentPan.x % largeGridSize;
        const largeOffsetY = currentPan.y % largeGridSize;

        // Glowing large grid lines
        ctx.shadowColor = 'rgba(100, 110, 130, 0.3)';
        ctx.shadowBlur = 8;
        ctx.strokeStyle = 'rgba(70, 80, 100, 0.25)';
        ctx.lineWidth = 1.5;

        ctx.beginPath();
        for (let i = largeOffsetX; i < width; i += largeGridSize) {
            ctx.moveTo(i, 0);
            ctx.lineTo(i, height);
        }
        for (let i = largeOffsetY; i < height; i += largeGridSize) {
            ctx.moveTo(0, i);
            ctx.lineTo(width, i);
        }
        ctx.stroke();
        ctx.shadowBlur = 0;

        // Glowing intersection points
        const pulseOpacity = (Math.sin(time * 0.002) + 1) * 0.15 + 0.1;
        for (let x = largeOffsetX; x < width; x += largeGridSize) {
            for (let y = largeOffsetY; y < height; y += largeGridSize) {
                // Outer glow
                const pointGlow = ctx.createRadialGradient(x, y, 0, x, y, 12);
                pointGlow.addColorStop(0, `rgba(150, 160, 180, ${pulseOpacity})`);
                pointGlow.addColorStop(0.5, `rgba(100, 110, 130, ${pulseOpacity * 0.5})`);
                pointGlow.addColorStop(1, 'transparent');
                ctx.fillStyle = pointGlow;
                ctx.fillRect(x - 12, y - 12, 24, 24);

                // Center dot
                ctx.fillStyle = `rgba(180, 190, 210, ${pulseOpacity * 1.5})`;
                ctx.beginPath();
                ctx.arc(x, y, 2, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        // Animated scanning line (horizontal)
        const scanY = (time * 0.02) % height;
        const scanGradient = ctx.createLinearGradient(0, scanY - 30, 0, scanY + 30);
        scanGradient.addColorStop(0, 'transparent');
        scanGradient.addColorStop(0.5, 'rgba(100, 110, 130, 0.05)');
        scanGradient.addColorStop(1, 'transparent');
        ctx.fillStyle = scanGradient;
        ctx.fillRect(0, scanY - 30, width, 60);
    };

    // Draw twinkling stars with parallax
    const drawStars = (ctx, width, height, currentPan, time) => {
        const parallaxX = currentPan.x * 0.08;
        const parallaxY = currentPan.y * 0.08;

        starsRef.current.forEach((star, i) => {
            // Multi-layer parallax
            const layerMultiplier = star.layer * 0.05;
            const x = ((star.x + parallaxX * (1 + layerMultiplier)) % width + width) % width;
            const y = ((star.y + parallaxY * (1 + layerMultiplier)) % height + height) % height;

            // Smooth twinkling
            const twinkle = Math.sin(time * star.twinkleSpeed * 0.001 + star.phase) * 0.4 + 0.6;
            const opacity = star.baseOpacity * twinkle;

            // Star glow
            if (star.size > 1.2) {
                const glowGradient = ctx.createRadialGradient(x, y, 0, x, y, star.size * 4);
                glowGradient.addColorStop(0, `rgba(${star.color}, ${opacity * 0.5})`);
                glowGradient.addColorStop(1, 'transparent');
                ctx.fillStyle = glowGradient;
                ctx.fillRect(x - star.size * 4, y - star.size * 4, star.size * 8, star.size * 8);
            }

            // Star core
            ctx.fillStyle = `rgba(${star.color}, ${opacity})`;
            ctx.beginPath();
            ctx.arc(x, y, star.size, 0, Math.PI * 2);
            ctx.fill();
        });
    };

    // Draw flowing particles along paths
    const drawFlowingParticles = (ctx, currentTree, currentZoom, currentPan, time) => {
        const getPos = (skill) => {
            const canvasWidth = canvasRef.current?.width || 1000;
            const canvasHeight = canvasRef.current?.height || 600;
            const x = (skill.position.x / 100) * (canvasWidth / window.devicePixelRatio) * currentZoom + currentPan.x;
            const y = (skill.position.y / 100) * (canvasHeight / window.devicePixelRatio) * currentZoom + currentPan.y;
            return { x, y };
        };

        // Draw particles flowing along completed paths
        currentTree.forEach(skill => {
            if (skill.status === 'mastered' || skill.status === 'unlocked') {
                skill.prerequisites?.forEach(prereqId => {
                    const prereq = currentTree.find(s => s.skillId === prereqId);
                    if (prereq && (prereq.status === 'mastered' || prereq.status === 'unlocked')) {
                        const start = getPos(prereq);
                        const end = getPos(skill);

                        // Multiple particles per path
                        for (let i = 0; i < 3; i++) {
                            const progress = ((time * 0.0003 + i * 0.33) % 1);
                            const x = start.x + (end.x - start.x) * progress;
                            const y = start.y + (end.y - start.y) * progress;

                            const particleOpacity = Math.sin(progress * Math.PI) * 0.6;

                            // Particle glow
                            const gradient = ctx.createRadialGradient(x, y, 0, x, y, 8 * currentZoom);
                            if (skill.status === 'mastered') {
                                gradient.addColorStop(0, `rgba(255, 255, 255, ${particleOpacity})`);
                                gradient.addColorStop(0.5, `rgba(200, 210, 230, ${particleOpacity * 0.5})`);
                            } else {
                                gradient.addColorStop(0, `rgba(100, 180, 180, ${particleOpacity})`);
                                gradient.addColorStop(0.5, `rgba(80, 150, 150, ${particleOpacity * 0.5})`);
                            }
                            gradient.addColorStop(1, 'transparent');

                            ctx.fillStyle = gradient;
                            ctx.beginPath();
                            ctx.arc(x, y, 6 * currentZoom, 0, Math.PI * 2);
                            ctx.fill();
                        }
                    }
                });
            }
        });
    };

    // Draw premium path connections
    const drawEdges = (ctx, currentSkillTree, currentZoom, currentPan, time) => {
        const getPos = (skill) => {
            const canvasWidth = canvasRef.current?.width || 1000;
            const canvasHeight = canvasRef.current?.height || 600;
            const x = (skill.position.x / 100) * (canvasWidth / window.devicePixelRatio) * currentZoom + currentPan.x;
            const y = (skill.position.y / 100) * (canvasHeight / window.devicePixelRatio) * currentZoom + currentPan.y;
            return { x, y };
        };

        currentSkillTree.forEach((skill) => {
            const { x: x1, y: y1 } = getPos(skill);

            skill.prerequisites?.forEach((prereqId) => {
                const prereq = currentSkillTree.find(s => s.skillId === prereqId);
                if (prereq) {
                    const { x: x2, y: y2 } = getPos(prereq);

                    // Calculate curve control point
                    const midX = (x1 + x2) / 2;
                    const midY = (y1 + y2) / 2 - Math.abs(x1 - x2) * 0.15;

                    // Path styling based on status
                    const isMasteredPath = skill.status === 'mastered' && prereq.status === 'mastered';
                    const isActivePath = skill.status === 'unlocked' || skill.status === 'mastered';
                    const isCurrentPath = skill.status === 'unlocked' && skill.masteryPercentage < skill.masteryThreshold;

                    // In fog mode, skip drawing locked paths entirely
                    const isFog = viewModeRef.current === 'fog';
                    if (isFog && !isActivePath && !isMasteredPath) {
                        return; // Hidden in fog
                    }

                    if (isMasteredPath) {
                        // Glowing white path for mastered connections
                        ctx.shadowColor = 'rgba(255, 255, 255, 0.4)';
                        ctx.shadowBlur = 15;
                        ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
                        ctx.lineWidth = 3 * currentZoom;
                        ctx.setLineDash([]);
                    } else if (isCurrentPath) {
                        // Animated teal path for current skill
                        const dashOffset = time * 0.02;
                        ctx.shadowColor = 'rgba(80, 180, 180, 0.4)';
                        ctx.shadowBlur = 12;
                        ctx.strokeStyle = 'rgba(100, 200, 200, 0.6)';
                        ctx.lineWidth = 2.5 * currentZoom;
                        ctx.setLineDash([10 * currentZoom, 6 * currentZoom]);
                        ctx.lineDashOffset = -dashOffset;
                    } else if (isActivePath) {
                        // Subtle glow for unlocked paths
                        ctx.shadowColor = 'rgba(150, 160, 190, 0.2)';
                        ctx.shadowBlur = 8;
                        ctx.strokeStyle = 'rgba(140, 150, 180, 0.4)';
                        ctx.lineWidth = 2 * currentZoom;
                        ctx.setLineDash([]);
                    } else {
                        // Dim locked paths (detail mode)
                        ctx.shadowBlur = 0;
                        ctx.strokeStyle = 'rgba(50, 55, 70, 0.3)';
                        ctx.lineWidth = 1.5 * currentZoom;
                        ctx.setLineDash([4 * currentZoom, 4 * currentZoom]);
                    }

                    ctx.lineCap = 'round';
                    ctx.beginPath();
                    ctx.moveTo(x2, y2);
                    ctx.quadraticCurveTo(midX, midY, x1, y1);
                    ctx.stroke();

                    // Reset
                    ctx.shadowBlur = 0;
                    ctx.setLineDash([]);
                }
            });
        });
    };

    // ═══════════════════════════════════════════════════════════════════════
    // ANIMATION LOOP
    // ═══════════════════════════════════════════════════════════════════════
    useEffect(() => {
        if (!canvasRef.current) return;

        // Initialize Stars with varied colors
        if (starsRef.current.length === 0) {
            const starColors = [
                '255, 255, 255', // White
                '200, 210, 230', // Cool white
                '180, 200, 220', // Soft blue-white
                '220, 220, 200', // Warm white
            ];

            for (let i = 0; i < 200; i++) {
                starsRef.current.push({
                    x: Math.random() * window.innerWidth * 2,
                    y: Math.random() * window.innerHeight * 2,
                    size: Math.random() * 1.8 + 0.3,
                    baseOpacity: Math.random() * 0.5 + 0.2,
                    twinkleSpeed: Math.random() * 2 + 1,
                    phase: Math.random() * Math.PI * 2,
                    layer: Math.floor(Math.random() * 3),
                    color: starColors[Math.floor(Math.random() * starColors.length)]
                });
            }
        }

        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');

        const render = (timestamp) => {
            if (!canvas) return;
            timeRef.current = timestamp;

            const rect = canvas.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;

            if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
                canvas.width = rect.width * dpr;
                canvas.height = rect.height * dpr;
                ctx.scale(dpr, dpr);
            }

            const currentZoom = zoomLevelRef.current;
            const currentPan = panOffsetRef.current;
            const currentTree = skillTreeRef.current;

            // Draw layers
            drawBackground(ctx, rect.width, rect.height, timestamp);
            drawGrid(ctx, rect.width, rect.height, currentPan, currentZoom, timestamp);
            drawStars(ctx, rect.width, rect.height, currentPan, timestamp);
            drawEdges(ctx, currentTree, currentZoom, currentPan, timestamp);
            drawFlowingParticles(ctx, currentTree, currentZoom, currentPan, timestamp);

            // Fog-of-war overlay: darken areas far from unlocked/mastered nodes
            if (viewModeRef.current === 'fog' && currentTree.length > 0) {
                // Dark overlay first
                ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
                ctx.fillRect(0, 0, rect.width, rect.height);

                // Cut clear spots around non-locked nodes using destination-out compositing
                ctx.save();
                ctx.globalCompositeOperation = 'destination-out';
                currentTree.forEach(skill => {
                    if (skill.status !== 'locked') {
                        const canvasWidth = rect.width;
                        const canvasHeight = rect.height;
                        const sx = (skill.position.x / 100) * canvasWidth * currentZoom + currentPan.x;
                        const sy = (skill.position.y / 100) * canvasHeight * currentZoom + currentPan.y;
                        const radius = skill.status === 'mastered' ? 180 * currentZoom : 120 * currentZoom;
                        const fogGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, radius);
                        fogGrad.addColorStop(0, 'rgba(0, 0, 0, 1)');
                        fogGrad.addColorStop(0.6, 'rgba(0, 0, 0, 0.7)');
                        fogGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
                        ctx.fillStyle = fogGrad;
                        ctx.beginPath();
                        ctx.arc(sx, sy, radius, 0, Math.PI * 2);
                        ctx.fill();
                    }
                });
                ctx.restore();
            }

            animationFrameRef.current = requestAnimationFrame(render);
        };

        animationFrameRef.current = requestAnimationFrame(render);

        return () => {
            if (animationFrameRef.current) {
                cancelAnimationFrame(animationFrameRef.current);
            }
        };
    }, []);

    // ═══════════════════════════════════════════════════════════════════════
    // LOADING STATE
    // ═══════════════════════════════════════════════════════════════════════
    if (loading) {
        return (
            <div className="flex items-center justify-center h-screen bg-gradient-to-b from-[#1a1d25] via-[#12141a] to-[#080a0e]">
                <div className="text-center">
                    <div
                        className="relative w-20 h-20 mx-auto mb-6"
                    >
                        <div className="absolute inset-0 rounded-full border-2 border-teal-500/30 animate-ping" />
                        <div className="absolute inset-2 rounded-full border-2 border-white/50" />
                        <div className="absolute inset-0 flex items-center justify-center">
                            <Sparkles className="w-8 h-8 text-white" />
                        </div>
                    </div>
                    <p
                       
                       
                        className="text-zinc-400 font-medium tracking-wide"
                    >
                        Loading Your Journey...
                    </p>
                </div>
            </div>
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    // MAIN RENDER
    // ═══════════════════════════════════════════════════════════════════════
    return (
        <div
            ref={containerRef}
            className="w-full h-screen flex flex-col bg-gradient-to-b from-[#1a1d25] via-[#12141a] to-[#080a0e] text-zinc-100 overflow-hidden"
        >
            {/* ═══════════════════════════════════════════════════════════════
                HEADER - Premium Glass Morphism
            ═══════════════════════════════════════════════════════════════ */}
            <div className="relative z-20 bg-gradient-to-b from-black/60 to-transparent backdrop-blur-xl border-b border-white/5">
                <div className="px-6 py-4">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-4">
                            {/* Icon with glow */}
                            <div
                                className="relative p-3 bg-gradient-to-br from-white/15 to-white/5 rounded-xl border border-white/10 shadow-lg"
                               
                               
                            >
                                <div className="absolute inset-0 rounded-xl bg-teal-500/10 blur-xl" />
                                <Target className="relative w-6 h-6 text-white" />
                            </div>
                            <div>
                                <h1 className="text-2xl font-bold text-white tracking-tight flex items-center gap-2">
                                    Skill Tree
                                    <span className="text-xs font-normal text-teal-400/80 bg-teal-400/10 px-2 py-0.5 rounded-full border border-teal-400/20">
                                        MASTERY PATH
                                    </span>
                                </h1>
                                <p className="text-sm text-zinc-400 mt-0.5">
                                    {skillTree.filter(s => s.status === 'mastered').length} / {skillTree.length} skills mastered
                                </p>
                            </div>
                        </div>

                        {/* Controls */}
                        <div className="flex items-center gap-3">
                            <button
                               
                               
                                onClick={() => setViewMode(viewMode === 'fog' ? 'detail' : 'fog')}
                                className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 hover:border-white/20 transition-all duration-200 text-zinc-300 backdrop-blur-sm"
                            >
                                {viewMode === 'fog' ? (
                                    <><EyeOff className="w-4 h-4 text-teal-400" /> Fog Mode</>
                                ) : (
                                    <><Eye className="w-4 h-4 text-teal-400" /> Detail Mode</>
                                )}
                            </button>
                            <button
                               
                               
                                onClick={() => { setZoomLevel(1); setPanOffset({ x: 0, y: 0 }); }}
                                className="px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 hover:border-white/20 transition-all duration-200 text-sm text-zinc-400 hover:text-white backdrop-blur-sm"
                            >
                                Reset View
                            </button>
                        </div>
                    </div>
                </div>

                {/* Progress Bar */}
                <div className="h-1 bg-black/30">
                    <div
                        className="h-full bg-gradient-to-r from-teal-500/50 via-white/60 to-teal-500/50"
                       
                        style={{ width: `${(skillTree.filter(s => s.status === 'mastered').length / skillTree.length) * 100}%` }}
                       
                    />
                </div>
            </div>

            {/* ═══════════════════════════════════════════════════════════════
                MAIN CANVAS AREA
            ═══════════════════════════════════════════════════════════════ */}
            <div className="flex flex-1 overflow-hidden relative">
                {/* Canvas Container */}
                <div className="flex-1 relative overflow-hidden">
                    <canvas
                        ref={canvasRef}
                        className="w-full h-full cursor-grab active:cursor-grabbing"
                        onWheel={handleWheel}
                        onMouseDown={handleMouseDown}
                        onMouseMove={handleMouseMove}
                        onMouseUp={handleMouseUp}
                        onMouseLeave={handleMouseUp}
                        onContextMenu={(e) => e.preventDefault()}
                    />

                    {/* Skill Nodes Overlay */}
                    {skillTree.map((skill) => {
                        const { x, y } = getNodePosition(skill);
                        const visuals = getNodeVisuals(skill);
                        const nodeSize = 70;
                        const isCurrent = visuals.state === 'current';

                        return (
                            <div
                                key={skill.skillId}
                                className="absolute pointer-events-auto"
                                style={{
                                    left: `${x - nodeSize / 2}px`,
                                    top: `${y - nodeSize / 2}px`,
                                    width: nodeSize,
                                    height: nodeSize
                                }}
                               
                               
                               
                                onMouseEnter={() => setHoveredSkill(skill.skillId)}
                                onMouseLeave={() => setHoveredSkill(null)}
                                onClick={() => setSelectedSkill(skill)}
                            >
                                <div
                                   
                                   
                                   
                                    className="relative w-full h-full cursor-pointer"
                                >
                                    {/* Outer glow ring for mastered */}
                                    {skill.status === 'mastered' && (
                                        <div
                                            className="absolute -inset-3 rounded-full"
                                            style={{
                                                background: `radial-gradient(circle, ${visuals.glow}, transparent 70%)`,
                                            }}
                                           
                                        />
                                    )}

                                    {/* Pulsing ring for current */}
                                    {isCurrent && (
                                        <>
                                            <div
                                                className="absolute -inset-4 rounded-full border-2 border-teal-400/30"
                                               
                                            />
                                            <div
                                                className="absolute -inset-2 rounded-full"
                                                style={{
                                                    background: `radial-gradient(circle, rgba(80, 180, 180, 0.3), transparent 70%)`,
                                                }}
                                               
                                               
                                            />
                                        </>
                                    )}

                                    {/* Main node */}
                                    <div
                                        className="absolute inset-0 rounded-full flex items-center justify-center transition-all duration-300 overflow-hidden"
                                        style={{
                                            background: visuals.background,
                                            border: `2px solid ${visuals.border}`,
                                            boxShadow: visuals.boxShadow,
                                            opacity: visuals.opacity
                                        }}
                                    >
                                        {/* Inner shine for mastered */}
                                        {skill.status === 'mastered' && (
                                            <div
                                                className="absolute inset-0 bg-gradient-to-tr from-transparent via-white/30 to-transparent"
                                            />
                                        )}

                                        {/* Blur overlay for locked */}
                                        {skill.status === 'locked' && (
                                            <div className={`absolute inset-0 rounded-full ${
                                                viewMode === 'fog'
                                                    ? 'backdrop-blur-md bg-black/60'
                                                    : 'backdrop-blur-[1px] bg-black/20'
                                            }`} />
                                        )}

                                        {/* Icons */}
                                        {skill.status === 'locked' && (
                                            <Lock className="w-5 h-5 text-zinc-600 relative z-10" />
                                        )}
                                        {skill.status === 'unlocked' && !isCurrent && (
                                            <Unlock className="w-5 h-5 text-zinc-300 relative z-10" />
                                        )}
                                        {isCurrent && (
                                            <div
                                               
                                               
                                            >
                                                <Target className="w-6 h-6 text-teal-300 relative z-10" />
                                            </div>
                                        )}
                                        {skill.status === 'mastered' && (
                                            <CheckCircle2 className="w-6 h-6 text-zinc-900 relative z-10" />
                                        )}
                                    </div>

                                    {/* Progress ring for current skill */}
                                    {isCurrent && (
                                        <svg className="absolute -inset-1 w-[calc(100%+8px)] h-[calc(100%+8px)] -rotate-90">
                                            <circle
                                                cx="50%"
                                                cy="50%"
                                                r="46%"
                                                fill="none"
                                                stroke="rgba(80, 180, 180, 0.2)"
                                                strokeWidth="3"
                                            />
                                            <circle
                                                cx="50%"
                                                cy="50%"
                                                r="46%"
                                                fill="none"
                                                stroke="rgba(100, 200, 200, 0.8)"
                                                strokeWidth="3"
                                                strokeLinecap="round"
                                                strokeDasharray={`${2 * Math.PI * 46} ${2 * Math.PI * 46}`}
                                               
                                            />
                                        </svg>
                                    )}

                                    {/* Premium Tooltip — hidden for locked nodes in fog mode */}
                                        {hoveredSkill === skill.skillId && !(viewMode === 'fog' && skill.status === 'locked') && (
                                            <div
                                               
                                               
                                               
                                                className="absolute left-1/2 -translate-x-1/2 bottom-full z-50 pointer-events-none"
                                            >
                                                <div className="relative w-56 p-4 rounded-xl bg-gradient-to-b from-zinc-800/95 to-zinc-900/95 backdrop-blur-xl border border-white/10 shadow-2xl shadow-black/50">
                                                    {/* Tooltip arrow */}
                                                    <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 w-4 h-4 rotate-45 bg-zinc-900/95 border-r border-b border-white/10" />

                                                    <p className="font-bold text-white text-sm">{skill.name}</p>
                                                    <p className="text-xs text-zinc-400 mt-1 flex items-center gap-1">
                                                        <span className={`w-1.5 h-1.5 rounded-full ${skill.status === 'mastered' ? 'bg-white' :
                                                            isCurrent ? 'bg-teal-400' :
                                                                skill.status === 'unlocked' ? 'bg-zinc-400' : 'bg-zinc-600'
                                                            }`} />
                                                        {skill.category}
                                                    </p>

                                                    {/* Progress bar in tooltip */}
                                                    <div className="mt-3 pt-3 border-t border-white/5">
                                                        <div className="flex justify-between text-xs mb-1.5">
                                                            <span className="text-zinc-500">Mastery</span>
                                                            <span className={`font-mono font-bold ${skill.status === 'mastered' ? 'text-white' :
                                                                isCurrent ? 'text-teal-400' : 'text-zinc-400'
                                                                }`}>{skill.masteryPercentage}%</span>
                                                        </div>
                                                        <div className="w-full h-1.5 bg-black/50 rounded-full overflow-hidden">
                                                            <div
                                                                className={`h-full rounded-full ${skill.status === 'mastered'
                                                                    ? 'bg-gradient-to-r from-white/80 to-white'
                                                                    : 'bg-gradient-to-r from-teal-500/50 to-teal-400'
                                                                    }`}
                                                               
                                                                style={{ width: `${skill.masteryPercentage}%` }}
                                                               
                                                            />
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        )}
                                </div>
                            </div>
                        );
                    })}

                    {/* Controls hint - glass style */}
                    <div
                       
                       
                       
                        className="absolute bottom-6 left-6 flex items-center gap-2 text-xs font-medium text-zinc-400 bg-black/40 backdrop-blur-md px-4 py-2 rounded-full border border-white/5"
                    >
                        <span className="text-zinc-500">SCROLL</span>
                        <span className="text-white/60">Zoom</span>
                        <span className="text-zinc-600 mx-1">•</span>
                        <span className="text-zinc-500">RIGHT-CLICK</span>
                        <span className="text-white/60">Pan</span>
                    </div>

                    {/* Quick stats overlay */}
                    <div
                       
                       
                       
                        className="absolute top-6 left-6 space-y-2"
                    >
                        <div className="flex items-center gap-3 bg-black/40 backdrop-blur-md px-4 py-2 rounded-xl border border-white/5">
                            <Star className="w-4 h-4 text-yellow-500/80" />
                            <span className="text-sm text-zinc-300">
                                <span className="font-bold text-white">{skillTree.filter(s => s.status === 'mastered').length}</span> Mastered
                            </span>
                        </div>
                        <div className="flex items-center gap-3 bg-black/40 backdrop-blur-md px-4 py-2 rounded-xl border border-white/5">
                            <Target className="w-4 h-4 text-teal-400/80" />
                            <span className="text-sm text-zinc-300">
                                <span className="font-bold text-white">{skillTree.filter(s => s.status === 'unlocked').length}</span> In Progress
                            </span>
                        </div>
                    </div>
                </div>

                {/* ═══════════════════════════════════════════════════════════════
                    DETAILS PANEL - Premium Glass Morphism
                ═══════════════════════════════════════════════════════════════ */}
                    {selectedSkill && (
                        <div
                           
                           
                           
                           
                            className="w-[380px] h-full bg-gradient-to-b from-zinc-900/95 to-zinc-950/98 backdrop-blur-2xl border-l border-white/5 shadow-2xl overflow-hidden flex flex-col"
                        >
                            {/* Panel Header */}
                            <div className="relative p-6 border-b border-white/5 bg-gradient-to-b from-white/5 to-transparent">
                                <button
                                   
                                   
                                    onClick={() => setSelectedSkill(null)}
                                    className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-full bg-white/5 hover:bg-white/10 border border-white/10 text-zinc-400 hover:text-white transition-colors"
                                >
                                    ✕
                                </button>

                                <div className="pr-10">
                                    <p className="text-xs text-teal-400/80 uppercase tracking-widest font-medium mb-2">{selectedSkill.category}</p>
                                    <h2 className="text-2xl font-bold text-white leading-tight">{selectedSkill.name}</h2>
                                </div>
                            </div>

                            {/* Content */}
                            <div className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar">
                                {/* Status Badge */}
                                <div className="flex items-center gap-3">
                                    <span className={`inline-flex items-center gap-2 px-4 py-2 rounded-full text-xs font-bold uppercase tracking-wider ${selectedSkill.status === 'mastered'
                                        ? 'bg-white text-zinc-900 shadow-lg shadow-white/20'
                                        : selectedSkill.status === 'unlocked'
                                            ? 'bg-teal-500/20 text-teal-300 border border-teal-500/30'
                                            : 'bg-zinc-800/50 text-zinc-500 border border-zinc-700/50'
                                        }`}>
                                        {selectedSkill.status === 'mastered' && <CheckCircle2 className="w-3.5 h-3.5" />}
                                        {selectedSkill.status === 'unlocked' && <Unlock className="w-3.5 h-3.5" />}
                                        {selectedSkill.status === 'locked' && <Lock className="w-3.5 h-3.5" />}
                                        {selectedSkill.status}
                                    </span>

                                    {selectedSkill.status === 'locked' && selectedSkill.blockedBy && (
                                        <span className="text-xs text-zinc-500 flex items-center gap-1.5 font-mono">
                                            <Lock className="w-3 h-3" />
                                            Requires: {selectedSkill.blockedBy}
                                        </span>
                                    )}
                                </div>

                                {/* Description */}
                                {selectedSkill.description && (
                                    <div className="p-4 rounded-xl bg-white/5 border border-white/5">
                                        <p className="text-sm text-zinc-300 leading-relaxed">{selectedSkill.description}</p>
                                    </div>
                                )}

                                {/* Mastery Progress */}
                                <div className="p-4 rounded-xl bg-gradient-to-br from-white/5 to-transparent border border-white/5">
                                    <div className="flex items-center justify-between mb-3">
                                        <p className="text-xs font-bold text-zinc-400 uppercase tracking-wider">Mastery Progress</p>
                                        <p className={`text-lg font-mono font-bold ${selectedSkill.status === 'mastered' ? 'text-white' : 'text-teal-400'
                                            }`}>
                                            {selectedSkill.masteryPercentage}%
                                        </p>
                                    </div>
                                    <div className="w-full h-2 bg-black/50 rounded-full overflow-hidden">
                                        <div
                                            className={`h-full rounded-full ${selectedSkill.status === 'mastered'
                                                ? 'bg-gradient-to-r from-zinc-300 via-white to-zinc-300'
                                                : 'bg-gradient-to-r from-teal-600 via-teal-400 to-teal-600'
                                                }`}
                                           
                                            style={{ width: `${selectedSkill.masteryPercentage}%` }}
                                           
                                        />
                                    </div>
                                    <p className="text-xs text-zinc-500 mt-2">
                                        {selectedSkill.masteryPercentage >= selectedSkill.masteryThreshold ? (
                                            <span className="text-white flex items-center gap-1">
                                                <CheckCircle2 className="w-3 h-3" /> Mastery Achieved
                                            </span>
                                        ) : (
                                            `${selectedSkill.masteryThreshold - selectedSkill.masteryPercentage}% to mastery`
                                        )}
                                    </p>
                                </div>

                                {/* Prerequisites */}
                                {selectedSkill.prerequisites && selectedSkill.prerequisites.length > 0 && (
                                    <div>
                                        <p className="text-xs font-bold text-zinc-400 uppercase tracking-wider mb-3">Requirements</p>
                                        <div className="space-y-2">
                                            {selectedSkill.prerequisites.map((prereqId) => {
                                                const prereq = skillTree.find(s => s.skillId === prereqId);
                                                const completed = prereq?.status === 'mastered';
                                                return (
                                                    <div
                                                        key={prereqId}
                                                        className={`flex items-center gap-3 p-3 rounded-lg border transition-colors ${completed
                                                            ? 'bg-white/5 border-white/10'
                                                            : 'bg-zinc-900/50 border-zinc-800/50'
                                                            }`}
                                                    >
                                                        <div className={`w-5 h-5 rounded-full flex items-center justify-center ${completed ? 'bg-white' : 'bg-zinc-700'
                                                            }`}>
                                                            {completed
                                                                ? <CheckCircle2 className="w-3 h-3 text-zinc-900" />
                                                                : <Lock className="w-2.5 h-2.5 text-zinc-500" />
                                                            }
                                                        </div>
                                                        <span className={`text-sm ${completed ? 'text-zinc-300' : 'text-zinc-500'}`}>
                                                            {prereq?.name || prereqId}
                                                        </span>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                )}

                                {/* Stats Grid */}
                                <div className="grid grid-cols-2 gap-3">
                                    <div className="p-4 rounded-xl bg-white/5 border border-white/5 text-center">
                                        <p className="text-[10px] text-zinc-500 uppercase tracking-wider">Difficulty</p>
                                        <p className="text-sm font-bold text-white mt-1">{selectedSkill.difficulty?.toUpperCase()}</p>
                                    </div>
                                    <div className="p-4 rounded-xl bg-white/5 border border-white/5 text-center">
                                        <p className="text-[10px] text-zinc-500 uppercase tracking-wider">Est. Time</p>
                                        <p className="text-sm font-bold text-white mt-1">{selectedSkill.estimatedHours}H</p>
                                    </div>
                                </div>
                            </div>

                            {/* Action Buttons */}
                            {selectedSkill.status === 'unlocked' && (
                                <div className="p-6 border-t border-white/5 bg-gradient-to-t from-zinc-950 to-transparent space-y-3">
                                    {treeId && (
                                        <button
                                            onClick={() => setShowTutor(true)}
                                            className="w-full py-3 bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 text-white font-bold rounded-xl flex items-center justify-center gap-3 shadow-lg shadow-blue-500/30 transition-all"
                                        >
                                            <MessageCircle className="w-5 h-5" />
                                            Discuss with AI Tutor
                                        </button>
                                    )}
                                    <button
                                        
                                        
                                        onClick={() => setShowAssessment(true)}
                                        className="w-full py-4 bg-gradient-to-r from-teal-500 to-teal-400 hover:from-teal-400 hover:to-teal-300 text-zinc-900 font-bold uppercase tracking-wider rounded-xl flex items-center justify-center gap-3 shadow-lg shadow-teal-500/30 transition-all"
                                    >
                                        <TrendingUp className="w-5 h-5" />
                                        Start Assessment
                                    </button>
                                    {treeId && (
                                        <button
                                            onClick={() => setShowNodeAssessment(true)}
                                            className="w-full py-3 bg-gradient-to-r from-purple-600 to-purple-500 hover:from-purple-500 hover:to-purple-400 text-white font-bold rounded-xl flex items-center justify-center gap-3 shadow-lg shadow-purple-500/30 transition-all"
                                        >
                                            <Brain className="w-5 h-5" />
                                            Quick Check
                                        </button>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                {/* Assessment Modal */}
                    {showAssessment && selectedSkill && (
                        <SkillAssessmentModal
                            skill={selectedSkill}
                            onClose={() => setShowAssessment(false)}
                            onSuccess={(result) => {
                                setShowAssessment(false);
                                fetchSkillTree();
                                if (selectedSkill) {
                                    const updated = skillTree.find(s => s.skillId === selectedSkill.skillId);
                                    if (updated) {
                                        setSelectedSkill({ ...updated, masteryPercentage: result.newMastery });
                                    }
                                }
                            }}
                        />
                    )}

                {/* AI Tutor Modal */}
                    {showTutor && selectedSkill && treeId && (
                        <NodeTutorChat
                            treeId={treeId}
                            nodeId={selectedSkill.skillId || selectedSkill.name}
                            nodeName={selectedSkill.name}
                            onClose={() => setShowTutor(false)}
                        />
                    )}

                {/* Node Quick Check Modal */}
                    {showNodeAssessment && selectedSkill && treeId && (
                        <NodeAssessmentModal
                            treeId={treeId}
                            nodeId={selectedSkill.skillId || selectedSkill.name}
                            nodeName={selectedSkill.name}
                            onClose={() => setShowNodeAssessment(false)}
                        />
                    )}
            </div>

            {/* ═══════════════════════════════════════════════════════════════
                LEGEND - Premium Footer
            ═══════════════════════════════════════════════════════════════ */}
            <div className="relative z-10 bg-gradient-to-t from-black/80 to-transparent backdrop-blur-sm border-t border-white/5 px-6 py-4">
                <div className="flex items-center justify-center gap-8 text-xs font-medium">
                    <div className="flex items-center gap-2 text-zinc-500">
                        <div className="w-4 h-4 rounded-full border border-zinc-700 bg-zinc-900/80 flex items-center justify-center">
                            <Lock className="w-2 h-2 text-zinc-600" />
                        </div>
                        <span>Locked</span>
                    </div>
                    <div className="flex items-center gap-2 text-zinc-400">
                        <div className="w-4 h-4 rounded-full border border-zinc-500 bg-zinc-800" />
                        <span>Unlocked</span>
                    </div>
                    <div className="flex items-center gap-2 text-teal-400">
                        <div className="w-4 h-4 rounded-full border-2 border-teal-400/50 bg-zinc-800 relative">
                            <div
                                className="absolute inset-0 rounded-full border border-teal-400/30"
                               
                               
                            />
                        </div>
                        <span>Current</span>
                    </div>
                    <div className="flex items-center gap-2 text-white">
                        <div className="w-4 h-4 rounded-full bg-white shadow-lg shadow-white/30" />
                        <span className="font-bold">Mastered</span>
                    </div>
                </div>
            </div>

            {/* Custom scrollbar styles */}
            <style jsx global>{`
                .custom-scrollbar::-webkit-scrollbar {
                    width: 6px;
                }
                .custom-scrollbar::-webkit-scrollbar-track {
                    background: transparent;
                }
                .custom-scrollbar::-webkit-scrollbar-thumb {
                    background: rgba(255, 255, 255, 0.1);
                    border-radius: 3px;
                }
                .custom-scrollbar::-webkit-scrollbar-thumb:hover {
                    background: rgba(255, 255, 255, 0.2);
                }
            `}</style>
        </div>
    );
};

export default SkillTreeMap;

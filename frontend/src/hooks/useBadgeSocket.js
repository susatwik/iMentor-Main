// frontend/src/hooks/useBadgeSocket.js
import { useEffect, useState, useCallback } from 'react';
import { io } from 'socket.io-client';
import { useAuth } from './useAuth';
import toast from 'react-hot-toast';

// Connect to the same origin so Vite's proxy forwards /socket.io → backend (avoids PNA/CORS issues)
const SOCKET_URL = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5001';

export const useBadgeSocket = () => {
    const { user } = useAuth();
    const [newBadge, setNewBadge] = useState(null);
    const [xpData, setXpData] = useState(null);       // latest { amount, newTotal, reason, topic }
    const [refreshCounter, setRefreshCounter] = useState(0); // bumped on every XP update

    // Force any consumers (useUserLevel, XPProgressModal) to re-fetch
    const triggerRefresh = useCallback(() => {
        setRefreshCounter(prev => prev + 1);
    }, []);

    useEffect(() => {
        if (!user || !user.id) return;

        const socket = io(SOCKET_URL, {
            transports: ['websocket', 'polling'],
            reconnection: true,
            reconnectionAttempts: 3,
            reconnectionDelay: 2000
        });

        const isDev = import.meta.env.DEV;

        socket.on('connect', () => {
            if (isDev) {
                console.log('[Socket] Connected to server at:', SOCKET_URL);
                console.log('[Socket] Joining room for user ID:', user.id);
            }
            socket.emit('join', user.id);
        });

        socket.on('joined', (data) => {
            if (isDev) {
                console.log('[Socket] Successfully joined room:', data.room);
            }
        });

        socket.on('badge_earned', (badge) => {
            if (isDev) {
                console.log('[Socket] 🏆 Badge earned!', badge);
            }
            setNewBadge(badge);
        });

        socket.on('xp_quality_bonus', (data) => {
            if (isDev) {
                console.log('[Socket] ⚡ XP quality bonus:', data);
            }
            const icon = data.score === 10 ? '🧠' : '✨';
            const msg  = data.score === 10
                ? `+${data.amount} XP — Excellent reasoning!`
                : `+${data.amount} XP — Good thinking!`;
            toast.success(msg, {
                icon,
                duration: 4000,
                style: {
                    background: 'rgba(107, 207, 127, 0.15)',
                    border: '1px solid rgba(107, 207, 127, 0.4)',
                    color: '#fff',
                },
            });
            // Quality bonus also updates total XP
            triggerRefresh();
        });

        socket.on('xp_awarded', (data) => {
            if (isDev) {
                console.log('[Socket] ⚡ XP awarded:', data);
            }
            if (data) {
                setXpData(data);
                triggerRefresh();

                if (data.amount > 0) {
                    toast(`⚡ +${data.amount} XP earned!  Total: ${data.newTotal || '—'}`, {
                        duration: 3500,
                        style: {
                            background: 'rgba(107, 207, 127, 0.15)',
                            border: '1px solid rgba(107, 207, 127, 0.4)',
                            color: '#6bcf7f',
                            fontWeight: '600',
                        },
                    });
                }
            }
        });

        socket.on('connect_error', (err) => {
            console.error('[Socket] Connection error:', err.message);
        });

        socket.on('disconnect', (reason) => {
            if (isDev) {
                console.log('[Socket] Disconnected from server:', reason);
            }
        });

        return () => {
            socket.disconnect();
        };
    }, [user, triggerRefresh]);

    const clearBadge = () => setNewBadge(null);

    return { newBadge, clearBadge, xpData, refreshCounter };
};

// frontend/src/hooks/useUserLevel.jsx
import { useState, useEffect } from 'react';
import axios from 'axios';

const apiClient = axios.create({
    baseURL: import.meta.env.VITE_API_BASE_URL || "http://localhost:5005",
});

// Add auth token to requests
apiClient.interceptors.request.use((config) => {
    const token = localStorage.getItem("authToken");
    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
});

/**
 * Hook to fetch and cache user's gamification level
 * @param {string} userId - Optional user ID (defaults to current user)
 * @returns {object} { level, loading, error }
 */
export function useUserLevel(userId = null) {
    const [level, setLevel] = useState(null);
    const [totalXP, setTotalXP] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        let isMounted = true;

        const fetchLevel = async () => {
            try {
                setLoading(true);

                // Fetch from gamification profile (baseURL already includes /api)
                const response = await apiClient.get('/gamification/profile');

                if (response && response.data && isMounted) {
                    // Prioritize XP level as it's the primary visible metric in the UI
                    const newLevel = response.data.xpLevel || response.data.level || 1;
                    const xp = response.data.totalXP || response.data.totalXp || response.data.xp || 0;
                    setLevel(newLevel);
                    setTotalXP(xp);
                    setError(null);
                }
            } catch (err) {
                if (import.meta.env.DEV) {
                    console.error('[useUserLevel] Error fetching level:', err);
                }
                if (isMounted) {
                    setError(err.message);
                    setLevel(1); // Default to level 1 if error
                    setTotalXP(0);
                }
            } finally {
                if (isMounted) {
                    setLoading(false);
                }
            }
        };

        // Fetch immediately
        fetchLevel();

        // Refresh every 30 seconds to avoid frequent re-renders
        const intervalId = setInterval(fetchLevel, 30000);

        return () => {
            isMounted = false;
            clearInterval(intervalId);
        };
    }, [userId]);

    return { level, totalXP, loading, error };
}
// frontend/src/hooks/useUserLevel.jsx
import { useState, useEffect } from 'react';
import axios from 'axios';

const apiClient = axios.create({
    baseURL: import.meta.env.VITE_API_BASE_URL || "http://localhost:2000",
});

// Add auth token to requests
apiClient.interceptors.request.use((config) => {
    const token = localStorage.getItem("authToken");
    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
});

/**
 * Hook to fetch and cache user's gamification level
 * @param {string} userId - Optional user ID (defaults to current user)
 * @returns {object} { level, loading, error }
 */
export function useUserLevel(userId = null) {
    const [level, setLevel] = useState(null);
    const [totalXP, setTotalXP] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        let isMounted = true;

        const fetchLevel = async () => {
            try {
                setLoading(true);

                // Fetch from gamification profile (baseURL already includes /api)
                const response = await apiClient.get('/gamification/profile');

                if (response && response.data && isMounted) {
                    // Prioritize XP level as it's the primary visible metric in the UI
                    const newLevel = response.data.xpLevel || response.data.level || 1;
                    const xp = response.data.totalXP || response.data.totalXp || response.data.xp || 0;
                    setLevel(newLevel);
                    setTotalXP(xp);
                    setError(null);
                }
            } catch (err) {
                if (import.meta.env.DEV) {
                    console.error('[useUserLevel] Error fetching level:', err);
                }
                if (isMounted) {
                    setError(err.message);
                    setLevel(1); // Default to level 1 if error
                    setTotalXP(0);
                }
            } finally {
                if (isMounted) {
                    setLoading(false);
                }
            }
        };

        // Fetch immediately
        fetchLevel();

        // Refresh every 30 seconds to avoid frequent re-renders
        const intervalId = setInterval(fetchLevel, 30000);

        return () => {
            isMounted = false;
            clearInterval(intervalId);
        };
    }, [userId]);

    return { level, totalXP, loading, error };
}

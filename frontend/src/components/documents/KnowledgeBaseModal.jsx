import React, { useEffect, useState } from 'react';
import { X, FilePlus } from 'lucide-react';
import { useAppState } from '../../contexts/AppStateContext.jsx';
import DocumentUpload from './DocumentUpload.jsx';
import KnowledgeSourceList from './KnowledgeSourceList.jsx';
import toast from 'react-hot-toast';

function KnowledgeBaseModal({ isOpen, onClose }) {
    const { selectDocumentForAnalysis, selectedDocumentForAnalysis } = useAppState();
    const [refreshKey, setRefreshKey] = useState(Date.now());

    useEffect(() => {
        if (!isOpen) return;

        const handleEscape = (event) => {
            if (event.key === 'Escape') onClose();
        };

        document.addEventListener('keydown', handleEscape);
        return () => document.removeEventListener('keydown', handleEscape);
    }, [isOpen, onClose]);

    const handleSourceAdded = () => {
        toast.success('New source added. Refreshing knowledge base...');
        setRefreshKey(Date.now());
    };

    if (!isOpen) return null;

    return (
        <div
            className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
            onClick={onClose}
            role="dialog"
            aria-modal="true"
        >
            <div
                onClick={(e) => e.stopPropagation()}
                className="w-full h-[100dvh] max-h-[100dvh] rounded-none border-0 bg-[#0B0F10] shadow-[0_20px_60px_rgba(0,0,0,0.5)] flex flex-col md:max-w-4xl md:h-auto md:max-h-[80vh] md:rounded-2xl md:border md:border-[#1D2A2D]"
            >
                <div className="flex items-center justify-between px-5 py-4 border-b border-[#1A2528] flex-shrink-0">
                    <div className="flex items-center gap-2 text-[#A6E8F0]">
                        <FilePlus size={16} />
                        <h3 className="text-sm font-semibold tracking-wide">My Knowledge Base</h3>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-1.5 rounded-md text-gray-400 hover:text-cyan-300 hover:bg-[#111A1F] transition-colors"
                        aria-label="Close knowledge base"
                    >
                        <X size={18} />
                    </button>
                </div>

                <div
                    className="flex-1 overflow-y-auto p-4 md:p-5 custom-scrollbar"
                    style={{
                        scrollbarWidth: 'thin',
                        scrollbarColor: '#22d3ee #0f172a',
                        scrollBehavior: 'smooth'
                    }}
                >
                    <DocumentUpload onSourceAdded={handleSourceAdded} />
                    <div className="mt-4">
                        <KnowledgeSourceList
                            key={refreshKey}
                            onSelectSource={selectDocumentForAnalysis}
                            selectedSource={selectedDocumentForAnalysis}
                            onRefreshNeeded={refreshKey}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}

export default KnowledgeBaseModal;

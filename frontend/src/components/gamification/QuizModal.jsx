import React, { useState } from 'react';
import { X, Check, ArrowRight, Brain } from 'lucide-react';
import Button from '../core/Button.jsx';
import api from '../../services/api';
import toast from 'react-hot-toast';

const QuizModal = ({ isOpen, onClose, bounty, onQuizCompleted }) => {
    const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
    const [answers, setAnswers] = useState({}); // { 0: 1, 1: 3 } (questionIndex: answerIndex)
    const [isSubmitting, setIsSubmitting] = useState(false);

    if (!isOpen || !bounty || !Array.isArray(bounty.quizData) || bounty.quizData.length === 0) return null;

    const questions = bounty.quizData;
    const currentQuestion = questions[currentQuestionIndex];
    const totalQuestions = questions.length;
    const progress = ((currentQuestionIndex + 1) / totalQuestions) * 100;

    const handleOptionSelect = (optionIndex) => {
        setAnswers({ ...answers, [currentQuestionIndex]: optionIndex });
    };

    const handleNext = () => {
        if (currentQuestionIndex < totalQuestions - 1) {
            setCurrentQuestionIndex(prev => prev + 1);
        } else {
            handleSubmit();
        }
    };

    const handlePrevious = () => {
        if (currentQuestionIndex > 0) {
            setCurrentQuestionIndex(prev => prev - 1);
        }
    };

    const handleSubmit = async () => {
        setIsSubmitting(true);
        // Convert answers object to array based on index
        const answersArray = [];
        for (let i = 0; i < totalQuestions; i++) {
            answersArray.push(answers[i] !== undefined ? answers[i] : -1);
        }

        try {
            const result = await api.submitQuiz(bounty._id, answersArray);
            toast.success(`Quiz completed! Score: ${result.score}%`);
            onQuizCompleted(result);
            onClose();
        } catch (error) {
            console.error("Quiz submission error:", error);
            toast.error("Failed to submit quiz.");
        } finally {
            setIsSubmitting(false);
        }
    };

    const isOptionSelected = answers[currentQuestionIndex] !== undefined;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
            <div className="bg-surface-light dark:bg-surface-dark w-full max-w-2xl rounded-2xl shadow-xl border border-border-light dark:border-border-dark overflow-hidden flex flex-col max-h-[90vh]">

                {/* Header */}
                <div className="p-4 border-b border-border-light dark:border-border-dark flex justify-between items-center bg-gray-50 dark:bg-gray-800/50">
                    <div>
                        <h2 className="text-lg font-bold flex items-center gap-2">
                            <Brain size={20} className="text-primary" />
                            {bounty.topic} Quiz
                        </h2>
                        <div className="flex items-center gap-2 text-xs text-text-muted-light dark:text-text-muted-dark mt-1">
                            <span>Question {currentQuestionIndex + 1} of {totalQuestions}</span>
                        </div>
                    </div>
                    <button onClick={onClose} className="p-1.5 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-full transition-colors">
                        <X size={20} className="text-text-muted-light dark:text-text-muted-dark" />
                    </button>
                </div>

                {/* Progress Bar */}
                <div className="w-full h-1.5 bg-gray-200 dark:bg-gray-700">
                    <div
                        className="h-full bg-primary transition-all duration-300 ease-out"
                        style={{ width: `${progress}%` }}
                    />
                </div>

                {/* Content */}
                <div className="p-6 overflow-y-auto flex-grow">
                    <div className="mb-2">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-primary bg-primary/10 px-2 py-1 rounded-full">
                            {currentQuestion.subTopic || 'General'}
                        </span>
                    </div>
                    <h3 className="text-xl font-medium text-text-light dark:text-text-dark mb-6 leading-relaxed">
                        {currentQuestion.questionText}
                    </h3>

                    <div className="space-y-3">
                        {currentQuestion.options.map((option, idx) => {
                            const isSelected = answers[currentQuestionIndex] === idx;
                            return (
                                <button
                                    key={idx}
                                    onClick={() => handleOptionSelect(idx)}
                                    className={`w-full p-4 text-left rounded-xl border transition-all duration-200 flex items-center gap-3 group
                                        ${isSelected
                                            ? 'border-primary bg-primary/5 shadow-sm ring-1 ring-primary'
                                            : 'border-border-light dark:border-border-dark hover:bg-gray-50 dark:hover:bg-gray-800'
                                        }`}
                                >
                                    <div className={`w-6 h-6 rounded-full border flex items-center justify-center flex-shrink-0 transition-colors
                                        ${isSelected ? 'border-primary bg-primary text-white' : 'border-gray-300 dark:border-gray-600 group-hover:border-primary/50'}`}>
                                        {isSelected && <Check size={14} />}
                                    </div>
                                    <span className={`text-sm ${isSelected ? 'font-medium text-primary' : 'text-text-light dark:text-text-dark'}`}>
                                        {option}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* Footer */}
                <div className="p-4 border-t border-border-light dark:border-border-dark bg-gray-50 dark:bg-gray-800/50 flex justify-between items-center">
                    <Button
                        variant="ghost"
                        onClick={handlePrevious}
                        disabled={currentQuestionIndex === 0 || isSubmitting}
                    >
                        Previous
                    </Button>
                    <Button
                        variant="primary"
                        onClick={handleNext}
                        disabled={!isOptionSelected || isSubmitting}
                        rightIcon={isSubmitting ? null : <ArrowRight size={16} />}
                        isLoading={isSubmitting}
                    >
                        {currentQuestionIndex === totalQuestions - 1 ? 'Submit Quiz' : 'Next Question'}
                    </Button>
                </div>
            </div>
        </div>
    );
};

export default QuizModal;

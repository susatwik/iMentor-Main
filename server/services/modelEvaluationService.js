/**
 * Model Evaluation & Selection Service
 * Implements Task 2.2.1: Base Model Selection Strategy
 * Recommends foundational base models (<3B parameters) based on course type.
 */

const baseModelRegistry = [
    { name: 'qwen2.5-1.5b-instruct', params: '1.5B', strengths: ['coding', 'general logic'], ramNeeded: '2GB' },
    { name: 'phi3-mini-4k', params: '3.8B', strengths: ['reasoning', 'math'], ramNeeded: '4GB' },
    { name: 'tinyllama-1.1b', params: '1.1B', strengths: ['speed', 'summarization'], ramNeeded: '1.5GB' }
];

/**
 * Recommends a base model architecture based on the academic subject
 */
function recommendBaseModel(courseName, complexityScore = 5) {
    const courseLower = courseName.toLowerCase();

    // Physics / Hard Math: Needs better reasoning (Phi-3)
    if (courseLower.includes('math') || courseLower.includes('physics') || complexityScore > 7) {
        return baseModelRegistry.find(m => m.name.includes('phi3'));
    }

    // Low complexity/resource constrained: TinyLlama
    if (complexityScore < 3) {
        return baseModelRegistry.find(m => m.name.includes('tinyllama'));
    }

    // Default fallback: Qwen2.5 1.5B
    return baseModelRegistry[0]; // qwen2.5
}

/**
 * Returns structural constraints for the QLoRA trainer based on model choice
 */
function getLoRAHyperparameters(baseModelName, courseType) {
    let rank = 16;
    let alpha = 32;

    if (courseType === 'STEM') {
        rank = 32;  // Higher rank for complex reasoning adaptation
        alpha = 64;
    }

    return { rank, alpha, dropout: 0.1 };
}

module.exports = {
    baseModelRegistry,
    recommendBaseModel,
    getLoRAHyperparameters
};

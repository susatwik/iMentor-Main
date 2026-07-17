const TutorStates = require('../config/tutorStates');

function emitStatus(socket, state) {
    socket.emit("tutor_status", {
        state,
        timestamp: Date.now()
    });
}

async function handleTutorQuestion(socket, question) {
    emitStatus(socket, TutorStates.THINKING);

    const intent = await analyzeIntent(question);

    emitStatus(socket, TutorStates.GENERATING);

    const rawAnswer = await generateAnswer(intent);

    emitStatus(socket, TutorStates.ANALYZING);

    const refinedAnswer = await analyzeAnswer(rawAnswer);

    emitStatus(socket, TutorStates.SUMMARIZING);

    const finalAnswer = summarize(refinedAnswer);

    socket.emit("tutor_message", {
        role: "tutor",
        content: finalAnswer
    });

    emitStatus(socket, TutorStates.IDLE);
}

module.exports = { handleTutorQuestion };

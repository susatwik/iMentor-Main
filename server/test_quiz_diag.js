const axios = require('axios');

async function run() {
    console.log('1. Fetching curriculum structure...');
    const start = Date.now();
    const { getCurriculumStructure } = require('./services/socraticTutorService');
    const structure = await getCurriculumStructure('CS1031');
    console.log('   Took', Date.now()-start, 'ms | modules:', structure?.modules?.length);

    console.log('2. Testing first 2 lecture fetches with 3s timeout...');
    const PYTHON_RAG_URL = 'http://127.0.0.1:2001';

    const fetchLectures = async (subs) => {
        const results = [];
        for (let i = 0; i < subs.length; i += 2) {
            const batch = subs.slice(i, i+2);
            console.log('   Batch', i/2+1, ':', batch.map(s => s.id));
            const start = Date.now();
            const res = await Promise.allSettled(batch.map(s =>
                axios.get(`${PYTHON_RAG_URL}/curriculum/CS1031/lecture/${s.id}`, 
                    { timeout: 3000, params: { subtopic_name: s.name, topic_name: s.topic } }
                ).then(r => ({ id: s.id, ok: true, len: r.data?.markdown?.length, warn: r.data?.markdown?.includes('⚠️') }))
                 .catch(e => ({ id: s.id, ok: false, err: e.message?.slice(0,60) }))
            ));
            console.log('   Took', Date.now()-start, 'ms');
            res.forEach(r => console.log('     ', r.value));
        }
    };

    const subs = [];
    for (const m of structure.modules) {
        for (const t of m.topics || []) {
            for (const s of t.subtopics || []) {
                subs.push({ id: s.id, name: s.name, topic: t.name });
            }
        }
    }
    console.log('   Total subtopics:', subs.length);
    await fetchLectures(subs.slice(0, 4));

    console.log('3. Testing Ollama generation...');
    const ollamaStart = Date.now();
    const resp = await axios.post('http://localhost:11434/api/generate', {
        model: 'qwen2.5-coder:7b',
        prompt: 'Generate 2 quiz questions about C programming loops. Return only the questions as JSON.',
        stream: false,
        options: { temperature: 0.3, num_predict: 500 }
    }, { timeout: 60000 });
    console.log('   Took', Date.now()-ollamaStart, 'ms');
    console.log('   Response:', resp.data?.response?.slice(0, 200));

    console.log('ALL DONE');
    process.exit(0);
}
run().catch(e => { console.error('FAILED:', e.message); process.exit(1); });

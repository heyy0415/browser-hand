// test-fetch.ts
// bun run test-fetch.ts

const apiKey = 'sk-3696886102834bbb99ca1773b25edd1e';

console.log('=== Bun fetch ===');
try {
    const res = await fetch(
        'https://dashscope.aliyuncs.com/compatible-mode/v1/models',
        { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    console.log('Status:', res.status);
    const text = await res.text();
    console.log('Body:', text.slice(0, 200));
} catch (err: any) {
    console.log('Error:', err.message);
}

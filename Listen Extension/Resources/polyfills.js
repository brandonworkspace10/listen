// Listen — polyfills loaded before kokoro.web.js.

// Safari doesn't support `for await` over a ReadableStream. kokoro-js's phonemizer uses it to
// unpack its English dictionary at startup; without this, every generate() call waits forever.
if (typeof ReadableStream !== "undefined" && !ReadableStream.prototype[Symbol.asyncIterator]) {
    ReadableStream.prototype[Symbol.asyncIterator] = async function* () {
        const reader = this.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) return;
                yield value;
            }
        } finally {
            reader.releaseLock();
        }
    };
}

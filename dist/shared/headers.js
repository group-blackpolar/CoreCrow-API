export function webHeaders(source) {
    const headers = new Headers();
    for (const [name, value] of Object.entries(source))
        if (value)
            headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    return headers;
}

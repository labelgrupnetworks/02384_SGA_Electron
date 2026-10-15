/**
 * The manifest endpoint, derived from the results one.
 *
 * A station is configured with the results URL, because that is the one the
 * bridge posts to by itself. Asking Verentia whether an order can be labelled
 * needs its sibling - and asking someone to type a second URL that is always
 * the first with one word changed is a way to end up with one of them pointing
 * at the wrong environment.
 */
function manifestUrlFrom(endpoint) {
    let url;

    try {
        url = new URL(String(endpoint ?? ''));
    } catch {
        return null;
    }

    const segments = url.pathname.split('/').filter(Boolean);

    if (segments.length === 0) {
        return null;
    }

    segments[segments.length - 1] = 'manifests';

    return `${url.origin}/${segments.join('/')}`;
}

module.exports = { manifestUrlFrom };

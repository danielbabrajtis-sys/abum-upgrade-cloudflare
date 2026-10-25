/**
 * ABUM UPGRADE D1 diagnostic endpoint for Cloudflare Pages.
 * Safe to open in a browser: it reveals only binding/table readiness, no player data.
 */
export async function onRequest({ request, env }) {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return Response.json(
      { ok: false, statusCode: 405, message: 'Use GET to check database readiness.' },
      { status: 405, headers }
    );
  }

  if (!env || !env.DB) {
    return Response.json(
      {
        ok: false,
        statusCode: 503,
        message: 'D1 binding DB is missing. In Pages Settings, bind database abum-upgrade-db using variable name DB.'
      },
      { status: 503, headers }
    );
  }

  try {
    const table = await env.DB
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .bind('abum_documents')
      .first();

    if (!table) {
      return Response.json(
        {
          ok: false,
          statusCode: 503,
          message: 'D1 is connected, but table abum_documents is missing. Run schema.sql in the D1 Console.'
        },
        { status: 503, headers }
      );
    }

    // Execute a tiny real query so a mere binding object is not treated as success.
    await env.DB.prepare('SELECT doc_key FROM abum_documents LIMIT 1').first();

    return Response.json(
      {
        ok: true,
        statusCode: 200,
        data: { ok: true, message: 'D1 connected; abum_documents table is ready.' }
      },
      { status: 200, headers }
    );
  } catch (error) {
    console.error('ABUM D1 health check failed:', String(error && error.message || error).slice(0, 200));
    return Response.json(
      {
        ok: false,
        statusCode: 503,
        message: 'D1 query failed. Confirm that DB is bound to abum-upgrade-db and schema.sql has run.'
      },
      { status: 503, headers }
    );
  }
}

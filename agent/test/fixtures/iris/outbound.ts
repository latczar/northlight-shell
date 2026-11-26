// The second sandbox client's website, for the test desk's outbound requests.
export function northwindResponse(request: Request): Promise<Response> | undefined {
  const url = new URL(request.url);
  if (url.hostname !== "northwind.example") return undefined;
  const routes: Record<string, () => Response> = {
    "/": () => new Response("<title>Northwind Cycles</title><h1>York Cycle Workshop</h1><meta name='description' content='Bicycle repairs'>", { headers: { "content-type": "text/html" } }),
  };
  return Promise.resolve(routes[url.pathname]?.() ?? new Response(null, { status: 404 }));
}

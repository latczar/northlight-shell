import { staffDesk } from './src/iris-staff.mjs';
import site from './site.json' with { type: 'json' };
import { serveVideo } from './src/video.mjs';

export default {
  fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/staff/iris' || path.startsWith('/staff/iris/')) {
      // Until Cloudflare Access protects the desk here, staff work with Iris in the Northlight console.
      if (!env.IRIS_ACCESS_ISSUER && site.staff?.sign_in) return Response.redirect(site.staff.sign_in, 302);
      return staffDesk(request, env);
    }
    // An optional hero video is served with byte ranges for mobile browsers.
    const hero = site.home.hero_video;
    if (hero && [hero.video, hero.mobile_video].includes(path)) return serveVideo(request, env.ASSETS);
    return env.ASSETS.fetch(request);
  },
};

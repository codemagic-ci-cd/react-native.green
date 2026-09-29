import type { APIRoute, GetStaticPaths } from 'astro';
import { badgeFor, badgeSvg } from '../../lib/badge';
import type { Package } from '../../lib/compat';
import { loadSiteData } from '../../lib/load';

export const getStaticPaths = (() =>
  loadSiteData().packages.map((pkg) => ({ params: { name: pkg.name }, props: { pkg } }))) satisfies GetStaticPaths;

export const GET = (({ props }) => {
  const { pkg } = props as { pkg: Package };
  return new Response(badgeSvg(badgeFor(pkg, loadSiteData().reactNative)), {
    headers: { 'Content-Type': 'image/svg+xml; charset=utf-8' },
  });
}) satisfies APIRoute;

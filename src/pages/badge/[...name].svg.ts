import type { APIRoute, GetStaticPaths } from 'astro';
import { badgeSvg } from '../../lib/badge';
import { verifiedRange, type Package } from '../../lib/compat';
import { loadSiteData } from '../../lib/load';

export const getStaticPaths = (() =>
  loadSiteData().packages.map((pkg) => ({ params: { name: pkg.name }, props: { pkg } }))) satisfies GetStaticPaths;

export const GET = (({ props }) => {
  const { pkg } = props as { pkg: Package };
  const range = verifiedRange(pkg, loadSiteData().reactNative);
  return new Response(badgeSvg(range), {
    headers: { 'Content-Type': 'image/svg+xml; charset=utf-8' },
  });
}) satisfies APIRoute;

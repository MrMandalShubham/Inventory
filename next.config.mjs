/** @type {import('next').NextConfig} */
const nextConfig = {
  // `pg` is a native-ish server package; keep it out of the bundle.
  serverExternalPackages: ["pg"],
};
export default nextConfig;

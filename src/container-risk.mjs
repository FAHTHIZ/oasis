// Container runs that hand the host to the container. Commands executed inside
// such a container escape every other shell check (a `rm -rf /h` inside
// `docker run -v /:/h` deletes the host's files), so both command tools ask a
// person first.

const HOST_SOURCE = /^(\/|~\/?|\$HOME\/?|\$\{HOME\}\/?|\/home\/?|\/Users\/?|\/root\/?|\/etc\/?|\/var\/run\/docker\.sock|\/run\/docker\.sock|[A-Za-z]:[\\/]?)$/;

function mountSource(spec) {
  const named = /(?:^|,)(?:source|src)=([^,]+)/.exec(spec);
  return named ? named[1] : spec.split(':')[0];
}

// Returns a reason string when `name args` starts a container with access to
// the host's root, home, /etc or Docker socket, or with host-level privileges.
export function containerHostAccess(name, args) {
  if (!/^(docker|podman|nerdctl)$/.test(name)) return '';
  const words = args.filter((a) => !a.startsWith('-'));
  const runs = words[0] === 'run' || words[0] === 'create' || (words[0] === 'container' && /^(run|create)$/.test(words[1] || ''));
  if (!runs) return '';
  const mounts = [];
  args.forEach((a, i) => {
    if (a === '-v' || a === '--volume' || a === '--mount') mounts.push(args[i + 1] || '');
    else if (/^(--volume|--mount)=/.test(a)) mounts.push(a.slice(a.indexOf('=') + 1));
    else if (/^-v./.test(a)) mounts.push(a.slice(2));
  });
  const host = mounts.map(mountSource).find((src) => HOST_SOURCE.test(src));
  if (host) return name + ' mounts ' + host + ' from the host into the container, so the container can change or delete it';
  if (args.includes('--privileged') || args.some((a) => /^--(pid|ipc|userns)=host$/.test(a) || /^--cap-add=(all|sys_admin)$/i.test(a))) {
    return name + ' starts a container with full access to the host';
  }
  return '';
}

// @ts-check
const SCRIPTS = {
  zsh: `# Install: add this line to ~/.zshrc
#   eval "$(ontologizer completion zsh)"
_ontologizer() {
  compadd -- \${(f)"$(ontologizer __complete \${words[2,CURRENT]})"}
}
compdef _ontologizer ontologizer
`,
  bash: `# Install: add this line to ~/.bashrc
#   eval "$(ontologizer completion bash)"
_ontologizer() {
  mapfile -t COMPREPLY < <(ontologizer __complete "\${COMP_WORDS[@]:1}")
}
complete -F _ontologizer ontologizer
`,
  fish: `# Install: add this line to ~/.config/fish/config.fish
#   ontologizer completion fish | source
complete -c ontologizer -f -a '(ontologizer __complete (commandline -opc)[2..] (commandline -ct))'
`,
};

export default {
  command: 'completion [shell]',
  describe: 'Print a shell completion script (zsh, bash or fish)',
  builder: (/** @type {any} */ y) => y.positional('shell', { choices: ['zsh', 'bash', 'fish'], describe: 'Shell (default: from $SHELL)' }),
  handler: async (/** @type {any} */ argv) => {
    const deps = argv.deps;
    const base = String(deps.env.SHELL ?? '').split('/').pop();
    const shell = argv.shell ?? (base === 'zsh' || base === 'fish' ? base : 'bash');
    deps.stdout.write(/** @type {Record<string,string>} */ (SCRIPTS)[shell]);
  },
};

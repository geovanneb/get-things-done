[English](README.md) · [日本語](README.ja.md) · [Português (Brasil)](README.pt-BR.md) · [Español](README.es.md)

# Get Things Done

**Uma memória para a IA que cresce com o seu trabalho.**

Registre reuniões, revise o que mudou e dê à sua IA o contexto necessário para entregar resultados.
Get Things Done é um projeto de código aberto que prioriza o armazenamento local, com memória de trabalho e gestão de tarefas para Claude Code, Codex e GitHub Copilot. Projetos, decisões, pessoas envolvidas e modelos de saída ficam em arquivos que o agente pode ler.

## Comece aqui

### Aplicativo desktop

[Baixe para macOS ou Windows](https://github.com/geovanneb/get-things-done/releases/latest). Escolha o instalador da sua plataforma e leia as notas da versão.

### CLI e navegador

Requer **Node.js 20.19 ou superior**; recomendamos 22 ou 24.

```bash
npm install -g @bertonha/getthingsdone
mkdir work-memory && cd work-memory
gtd init
gtd start
```

Escolha sua ferramenta de IA durante a configuração. O painel local abre no navegador.

## Como usar

1. Cadastre as pessoas envolvidas e o contexto do projeto.
2. Grave uma reunião ou importe gravações e transcrições. Informe os participantes e obtenha consentimento antes de gravar.
3. Antes de transcrever áudio, baixe um modelo em **Settings → Transcription**.
4. Revise e aprove as mudanças propostas pela IA. Crie uma tarefa vinculada ao contexto relevante.

O espaço de trabalho e a transcrição offline não exigem uma conta do Get Things Done. A análise e a execução de tarefas usam a ferramenta de IA que você escolher, que pode exigir conta ou assinatura própria. Você aprova as mudanças e revisa as entregas.

## Idioma da interface

Na versão em desenvolvimento, o idioma segue as preferências do sistema ou do navegador e pode ser alterado em **Settings → Appearance → Language**. A base oferece inglês, japonês, português do Brasil e espanhol latino-americano. A tradução inicial cobre rótulos de navegação, títulos e parte dos controles de aparência. Muitas telas, os menus nativos e a CLI continuam em inglês. Consulte as notas da versão para saber se o recurso já está disponível na versão publicada.

O idioma da interface é independente do idioma falado nas gravações e das preferências de idioma para as entregas da IA.

## Documentação e participação

- [Apresentação completa (inglês)](README.md)
- [Guia do usuário (inglês)](docs/user-guide.md)
- [Histórico de mudanças](CHANGELOG.md) e [como contribuir](CONTRIBUTING.md)
- [Bugs e sugestões](https://github.com/geovanneb/get-things-done/issues) e [relatos de segurança](SECURITY.md)

Contribuições para as traduções são bem-vindas. Use dados fictícios em issues e capturas de tela, nunca informações reais do trabalho.

[Licença MIT](LICENSE). Esta página é um resumo do README em inglês; consulte a versão completa para os detalhes.

<!-- English source: README.md at 50aada22b090215270d3cf6896ed41d9cfda11bb; concise introduction, not a full translation. -->

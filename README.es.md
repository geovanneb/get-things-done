[English](README.md) · [日本語](README.ja.md) · [Português (Brasil)](README.pt-BR.md) · [Español](README.es.md)

# Get Things Done

**Una memoria para la IA que crece con tu trabajo.**

Registra reuniones, revisa qué cambió y dale a tu IA el contexto necesario para entregar resultados.
Get Things Done es un proyecto de código abierto que prioriza el almacenamiento local, con memoria de trabajo y gestión de tareas para Claude Code, Codex y GitHub Copilot. Guarda proyectos, decisiones, personas involucradas y plantillas de salida en archivos que el agente puede leer.

## Primeros pasos

### Aplicación de escritorio

[Descarga para macOS o Windows](https://github.com/geovanneb/get-things-done/releases/latest). Elige el instalador de tu plataforma y consulta las notas de la versión.

### CLI y navegador

Requiere **Node.js 20.19 o posterior**; recomendamos 22 o 24.

```bash
npm install -g @bertonha/getthingsdone
mkdir work-memory && cd work-memory
gtd init
gtd start
```

Elige tu herramienta de IA durante la configuración. El panel local se abre en el navegador.

## Cómo usarlo

1. Agrega a las personas involucradas y el contexto del proyecto.
2. Graba una reunión o importa grabaciones y transcripciones. Informa a los participantes y obtén su consentimiento antes de grabar.
3. Antes de transcribir audio, descarga un modelo en **Settings → Transcription**.
4. Revisa y aprueba los cambios que propone la IA. Crea una tarea vinculada al contexto relevante.

El espacio de trabajo y la transcripción sin conexión no requieren una cuenta de Get Things Done. El análisis y la ejecución de tareas usan la herramienta de IA que elijas, que puede requerir su propia cuenta o suscripción. Tú apruebas los cambios y revisas las entregas.

## Idioma de la interfaz

En la versión en desarrollo, el idioma sigue las preferencias del sistema o del navegador y se puede cambiar en **Settings → Appearance → Language**. La base ofrece inglés, japonés, portugués de Brasil y español latinoamericano. La traducción inicial incluye etiquetas de navegación, títulos y parte de los controles de apariencia. Muchas pantallas, los menús nativos y la CLI siguen en inglés. Consulta las notas de la versión para saber si la función ya está disponible en la versión publicada.

El idioma de la interfaz es independiente del idioma hablado en las grabaciones y de las preferencias de idioma para las entregas de la IA.

## Documentación y participación

- [Presentación completa (inglés)](README.md)
- [Guía del usuario (inglés)](docs/user-guide.md)
- [Historial de cambios](CHANGELOG.md) y [cómo contribuir](CONTRIBUTING.md)
- [Errores y sugerencias](https://github.com/geovanneb/get-things-done/issues) e [informes de seguridad](SECURITY.md)

Las mejoras a las traducciones son bienvenidas. Usa datos ficticios en los issues y las capturas de pantalla, nunca información real del trabajo.

[Licencia MIT](LICENSE). Esta página resume el README en inglés; consulta la versión completa para ver los detalles.

<!-- English source: README.md at 50aada22b090215270d3cf6896ed41d9cfda11bb; concise introduction, not a full translation. -->

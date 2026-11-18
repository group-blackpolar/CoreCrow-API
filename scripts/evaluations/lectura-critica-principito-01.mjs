// Declarative definition of the "Lectura Crítica — El principito | Simulacro 01" exam. This file is DATA for the generic importer
// (scripts/import-evaluation.mjs): nothing in NORTH or CORECROW knows this exam. Everything below ends up as evaluation content in
// PostgreSQL (sections, reference texts, questions, options, answer key, explanations, settings) and is editable afterwards through
// Exam Builder or the API, with versioning. The answer key (`correct`) never leaves the server during an attempt.
//
// Original work: Antoine de Saint-Exupéry. The reference texts are original adaptations written for this exam.
const p = (text) => ({ type: "paragraph", text });
const q = (prompt, category, options, correct, explanation) => ({ prompt: [p(prompt)], category, options, correct, explanation: [p(explanation)], points: 1 });
const LITERAL = "Comprensión literal";
const INFERENCIAL = "Comprensión inferencial";
const CRITICA = "Evaluación crítica";

export default {
  key: "lectura-critica-principito-01",
  kind: "EXAM",
  title: "Lectura Crítica — El principito | Simulacro 01",
  description: "Simulacro de lectura crítica sobre El principito, de Antoine de Saint-Exupéry. Tres sesiones de cinco preguntas (capítulos II, XIV y XXI) que evalúan comprensión literal e inferencial y evaluación crítica. Selección múltiple con única respuesta; cada pregunta dispone de 2 minutos y el simulacro completo de 30 minutos. Los textos son adaptaciones originales.",
  settings: {
    durationMinutes: 30,
    maxAttempts: 1,
    scoring: { wrongPenaltyPercent: 0, unansweredPenaltyPercent: 0, floorAtZero: true },
    review: { mode: "AFTER_SUBMIT", revealAfter: null },
    ai: { allowedDuringAttempt: false },
    // Sequential, server-timed: 120 s per question from the moment the server opens it, no way back after confirming.
    pacing: { navigation: "FORWARD_ONLY", questionSeconds: 120 },
  },
  // People who may take it (data, not code). Authors and result readers are governed by their permissions.
  assignments: [{ role: "MEMBER" }, { role: "VIEWER" }],
  publish: true,
  sections: [
    {
      title: "Sesión 1 — Capítulo II: El aviador y el cordero",
      description: "Competencias: comprensión literal e inferencial. Dificultad: básica-media. Duración máxima: 10 minutos.",
      passage: {
        title: "Capítulo II — El aviador y el cordero",
        body: [
          p("Adaptación original basada en el capítulo II de El principito."),
          p("Un aviador viajaba solo cuando una avería lo obligó a aterrizar en pleno desierto. Con poca agua y sin ayuda, dedicaba sus esfuerzos a reparar el motor."),
          p("A la mañana siguiente, una voz lo despertó: un niño desconocido le pidió que dibujara un cordero. El aviador se sorprendió de encontrarlo en aquel lugar y, sobre todo, de que no pareciera preocupado por estar lejos de cualquier poblado."),
          p("Aunque decía que no era buen dibujante, hizo varios intentos. Primero mostró un dibujo antiguo de una serpiente que había tragado un elefante. El niño reconoció la figura y aclaró que no era lo que buscaba."),
          p("Después rechazó varios corderos: uno parecía enfermo, otro tenía cuernos y otro era demasiado viejo."),
          p("Finalmente, cansado, el aviador dibujó una caja con agujeros y explicó que el cordero estaba dentro. El niño aceptó contento aquel último dibujo."),
          p("Por un momento, el problema del avión dejó de ocupar toda la atención del piloto."),
        ],
      },
      questions: [
        q("¿Por qué se encontraba el aviador en el desierto?", LITERAL, ["Había viajado hasta allí para buscar al niño.", "Una avería lo obligó a aterrizar.", "Estaba realizando dibujos para una investigación.", "Se había perdido mientras seguía a un cordero."], "B", "El aterrizaje fue provocado por una avería del avión."),
        q("¿Qué dibujo aceptó finalmente el niño?", LITERAL, ["Una serpiente que había tragado un elefante.", "Un cordero con cuernos.", "Una caja que contenía un cordero imaginado.", "Un cordero de aspecto envejecido."], "C", "El niño acepta la caja porque puede imaginar el cordero dentro."),
        q("¿Qué permite inferir el rechazo de los primeros dibujos?", INFERENCIAL, ["El niño tenía una idea de lo que necesitaba y los dibujos no la satisfacían.", "El niño rechazaba cualquier dibujo realizado por adultos.", "El aviador se negaba a escuchar las peticiones del niño.", "El niño había decidido abandonar su búsqueda de un cordero."], "A", "Sus rechazos muestran que busca un cordero con determinadas características."),
        q("¿Por qué el dibujo de la caja consigue satisfacer al niño?", INFERENCIAL, ["Porque demuestra que el aviador finalmente aprendió a dibujar animales.", "Porque contiene una representación detallada de un cordero.", "Porque reproduce exactamente los animales rechazados anteriormente.", "Porque permite imaginar al cordero sin imponerle una apariencia concreta."], "D", "La representación indirecta deja espacio para la imaginación."),
        q("¿Qué contraste contribuye principalmente al sentido del encuentro entre ambos personajes?", CRITICA, ["La experiencia del aviador frente al conocimiento técnico del niño.", "La preocupación práctica del aviador frente a la petición imaginativa del niño.", "La necesidad de viajar frente al deseo de permanecer en el desierto.", "La desconfianza del aviador frente a la intención hostil del niño."], "B", "El encuentro enfrenta una urgencia material con una solicitud imaginativa."),
      ],
    },
    {
      title: "Sesión 2 — Capítulo XIV: El farolero y su obligación",
      description: "Competencias: inferencia, análisis de contradicciones y evaluación crítica. Dificultad: media. Duración máxima: 10 minutos.",
      passage: {
        title: "Capítulo XIV — El farolero y su obligación",
        body: [
          p("Adaptación original basada en el capítulo XIV de El principito."),
          p("Durante su viaje, el principito llegó a un planeta muy pequeño donde vivía un farolero. El hombre encendía un farol y, apenas un momento después, lo apagaba. Repetía aquella secuencia sin descanso."),
          p("Cuando el principito preguntó por qué lo hacía, el farolero explicó que debía obedecer una instrucción: encender el farol al anochecer y apagarlo al amanecer."),
          p("En otro tiempo, la tarea era sencilla y le permitía descansar. Pero el planeta había comenzado a girar cada vez más rápido, hasta completar una vuelta en apenas un minuto. La instrucción seguía siendo la misma."),
          p("Aunque el farolero estaba agotado, continuaba cumpliendo su obligación."),
          p("El principito sintió simpatía por él. A diferencia de otros adultos que había conocido, aquel hombre se ocupaba de algo distinto de sí mismo."),
          p("Intentó encontrar una solución para que pudiera descansar, pero el farolero deseaba, sobre todo, dormir."),
          p("Al marcharse, el principito pensó que le habría gustado quedarse con él. Sin embargo, el planeta era demasiado pequeño para albergar a los dos."),
        ],
      },
      questions: [
        q("¿Cuál era la instrucción que debía cumplir el farolero?", LITERAL, ["Mantener el farol encendido durante todo el día.", "Encenderlo cada vez que llegara un visitante.", "Encenderlo al anochecer y apagarlo al amanecer.", "Apagarlo únicamente cuando necesitara descansar."], "C", "La instrucción vincula encender y apagar el farol con la noche y el amanecer."),
        q("¿Cuál es el conflicto principal que enfrenta el farolero?", INFERENCIAL, ["Las condiciones del planeta cambiaron, pero su instrucción permaneció igual.", "El principito le exige abandonar el trabajo que le gusta.", "El farol deja de funcionar y nadie puede repararlo.", "Los habitantes del planeta no reconocen su esfuerzo."], "A", "El planeta acelera su rotación mientras la instrucción no cambia."),
        q("¿Por qué el principito siente simpatía por el farolero?", INFERENCIAL, ["Porque posee el planeta más grande que ha visitado.", "Porque consigue descansar sin abandonar sus obligaciones.", "Porque demuestra que las personas adultas nunca se equivocan.", "Porque su actividad está orientada a algo distinto de sus propios intereses."], "D", "El principito valora que el farolero se ocupe de algo más allá de sí mismo."),
        q("¿Qué crítica puede construirse a partir de la situación del farolero?", CRITICA, ["Toda actividad repetitiva carece necesariamente de valor.", "Una regla que no se adapta a nuevas circunstancias puede convertirse en una carga desproporcionada.", "El trabajo solo tiene sentido cuando produce beneficios económicos.", "Las obligaciones deben abandonarse siempre que resulten difíciles."], "B", "La rigidez de una norma puede hacerla desproporcionada ante circunstancias nuevas."),
        q("¿Cuál de las siguientes conclusiones interpreta mejor la relación entre el deber del farolero y su situación?", CRITICA, ["La obediencia garantiza que una regla seguirá siendo adecuada con el paso del tiempo.", "El agotamiento del farolero demuestra que su trabajo nunca tuvo ningún propósito.", "El compromiso con una tarea puede ser valioso, aunque sus reglas necesiten revisarse cuando cambia el contexto.", "El principito considera que cualquier obligación es menos importante que el descanso."], "C", "La dedicación del farolero es valiosa, aunque la regla resulte inadecuada."),
      ],
    },
    {
      title: "Sesión 3 — Capítulo XXI: El zorro y el significado de los vínculos",
      description: "Competencias: comprensión global, simbolismo y reflexión crítica. Dificultad: media-alta. Duración máxima: 10 minutos.",
      passage: {
        title: "Capítulo XXI — El zorro y el significado de los vínculos",
        body: [
          p("Adaptación original basada en el capítulo XXI de El principito."),
          p("El principito conoció a un zorro que no quiso jugar con él inmediatamente. Antes debían establecer una relación, explicó el animal."),
          p("Dos seres que no se conocen pueden parecerse a miles de otros. Sin embargo, cuando dedican tiempo a conocerse, comienzan a ocupar un lugar especial en sus vidas."),
          p("El zorro le pidió paciencia. Al principio debían mantener cierta distancia y después acercarse poco a poco. También habló de la importancia de los rituales: encontrarse en momentos conocidos permitía esperar con ilusión algo que antes parecía ordinario."),
          p("El zorro señaló unos campos de trigo. Aunque no comía pan y aquellos campos antes no significaban nada para él, su color dorado podría recordarle al principito cuando ya no estuvieran juntos."),
          p("El pequeño pensó entonces en la rosa que había dejado en su planeta. Había visto muchas otras flores aparentemente semejantes, pero comprendió que su rosa era especial por el tiempo que le había dedicado: la había regado, protegido y escuchado."),
          p("Entendió que establecer un vínculo no solo transforma la manera de mirar a alguien, sino que también implica asumir responsabilidades."),
        ],
      },
      questions: [
        q("¿Por qué el zorro no desea jugar inmediatamente con el principito?", INFERENCIAL, ["Porque considera que el principito representa un peligro.", "Porque todavía no existe entre ellos un vínculo que les permita relacionarse de manera especial.", "Porque ha decidido no establecer relaciones con otros seres.", "Porque únicamente acepta jugar con personas que conoce desde hace años."], "B", "El zorro considera necesario construir primero una relación."),
        q("¿Qué función cumplen los rituales según la explicación del zorro?", INFERENCIAL, ["Permiten anticipar los encuentros y convertir momentos comunes en ocasiones significativas.", "Evitan que las relaciones cambien con el paso del tiempo.", "Garantizan que dos seres permanezcan siempre juntos.", "Sustituyen la necesidad de construir confianza entre las personas."], "A", "Los rituales producen anticipación y otorgan significado a los encuentros."),
        q("¿Qué representan los campos de trigo para el zorro después de conocer al principito?", CRITICA, ["La necesidad de abandonar sus costumbres anteriores.", "La importancia de obtener alimento mediante el trabajo.", "La capacidad de un elemento cotidiano para despertar el recuerdo de alguien significativo.", "La prueba de que todos los lugares tienen el mismo significado para cualquier individuo."], "C", "El trigo adquiere un nuevo significado por su asociación con el principito."),
        q("¿Por qué la rosa del principito adquiere un valor especial frente a las demás?", CRITICA, ["Porque es físicamente superior a todas las otras rosas.", "Porque nunca ha necesitado atención ni protección.", "Porque el principito no había conocido otras flores antes de ella.", "Porque el tiempo y el cuidado que le ha dedicado han construido un vínculo particular."], "D", "El cuidado y el tiempo compartido explican el valor particular de la rosa."),
        q("¿Cuál es la conclusión que mejor integra las enseñanzas del zorro?", CRITICA, ["Los vínculos transforman el significado de experiencias cotidianas y también generan responsabilidades.", "El valor de una relación depende principalmente de la apariencia de quienes participan en ella.", "Evitar cualquier vínculo es la mejor forma de prevenir las dificultades emocionales.", "Todas las relaciones adquieren importancia de manera inmediata, sin necesidad de tiempo ni atención."], "A", "La relación da significado a las experiencias y exige responsabilidad."),
      ],
    },
  ],
};

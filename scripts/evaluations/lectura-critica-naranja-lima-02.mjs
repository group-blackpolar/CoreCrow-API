// Declarative definition of the "Lectura Critica - Mi planta naranja-lima | Simulacro 02" exam. This file is DATA for the generic importer
// (scripts/import-evaluation.mjs): nothing in NORTH or CORECROW knows this exam. It ends up as evaluation content in PostgreSQL (sections, reference
// text, questions, options, answer key, explanations, skills, thresholds, settings) and is editable afterwards through Exam Builder or the API, with
// versioning. The answer key (`correct`) never leaves the server during an attempt.
//
// Reference material: "Lectura Quiz 2 - Mi planta de naranja-lima", chapter "Los flacos dedos de la pobreza". The student already read the chapter,
// so the questions assess comprehension, interpretation and critical analysis; they are not a reproduction of the reading.
const p = (text) => ({ type: "paragraph", text });
const LITERAL = "Comprensión literal";
const INFERENCIAL = "Comprensión inferencial";
const CRITICA = "Lectura crítica";
const CHAPTER = "Mi planta de naranja-lima, capítulo «Los flacos dedos de la pobreza»";
const q = (category, topic, skill, difficulty, prompt, options, correct, explanation, reference = CHAPTER) =>
  ({ prompt: [p(prompt)], category, topic, skills: [skill], difficulty, reference, options, correct, explanation: [p(explanation)], points: 1 });

export default {
  key: "lectura-critica-naranja-lima-02",
  kind: "EXAM",
  categoryKey: "lectura-critica",
  title: "Lectura Critica - Mi planta naranja-lima | Simulacro 02",
  description: "Simulacro de lectura crítica sobre el capítulo «Los flacos dedos de la pobreza», de Mi planta de naranja-lima. Tres sesiones de cinco preguntas (comprensión literal, inferencial y crítica), de selección múltiple con única respuesta, estilo ICFES. Cada pregunta dispone de 2 minutos y cada sesión de 30 minutos como máximo.",
  settings: {
    durationMinutes: 90,
    maxAttempts: 1,
    scoring: { wrongPenaltyPercent: 0, unansweredPenaltyPercent: 0, floorAtZero: true },
    review: { mode: "AFTER_SUBMIT", revealAfter: null },
    ai: { allowedDuringAttempt: false },
    // Sequential, server-timed: 120 s per question from the moment the server opens it, 30 min per session, no way back after confirming.
    pacing: { navigation: "FORWARD_ONLY", questionSeconds: 120, sessionMinutes: 30 },
    // Internal levels of this simulacro (not an official ICFES scale).
    performance: { levels: [
      { key: "low", label: "Bajo", minPercent: 0, summary: "Esta competencia necesita trabajo de base antes de pasar a ejercicios más exigentes." },
      { key: "basic", label: "Básico", minPercent: 40, summary: "Tienes bases en esta competencia, pero todavía no las aplicas de forma consistente." },
      { key: "high", label: "Alto", minPercent: 60, summary: "Muestras una buena capacidad en esta competencia, con aspectos puntuales por pulir." },
      { key: "superior", label: "Superior", minPercent: 80, summary: "Tu dominio de esta competencia es sólido y consistente." },
    ] },
  },
  assignments: [{ role: "MEMBER" }, { role: "VIEWER" }],
  publish: true,
  // Wording used by the feedback service (strength / gap are infinitive phrases; study is a noun phrase; strategy is an instruction).
  skills: [
    { id: "narrador-perspectiva", competency: LITERAL, label: "Narrador y perspectiva", strength: "identificar quién narra y desde qué perspectiva", gap: "identificar quién narra y desde qué perspectiva", study: "la diferencia entre el narrador en primera persona y el narrador externo", strategy: "pregúntate quién dice «yo» en el texto y qué sabe realmente ese personaje" },
    { id: "personajes-relaciones", competency: LITERAL, label: "Personajes y relaciones", strength: "reconocer a los personajes y las relaciones entre ellos", gap: "establecer las relaciones entre los personajes (Zezé, Luis, Luciano y Minguito)", study: "los personajes del capítulo y su relación con Zezé", strategy: "elabora un esquema que relacione a Zezé con los demás personajes" },
    { id: "acontecimientos-clave", competency: LITERAL, label: "Acontecimientos clave", strength: "recordar los hechos relevantes de la historia", gap: "recordar qué hace cada personaje ante los hechos relevantes, como la solución que encuentra Gloria para ir al Casino Bangú", study: "los sucesos de la víspera de Navidad y la visita al Casino Bangú", strategy: "resume cada escena en una frase que diga quién hace qué y para qué" },
    { id: "secuencia-cronologica", competency: LITERAL, label: "Orden cronológico", strength: "ordenar cronológicamente los sucesos", gap: "ordenar cronológicamente los sucesos", study: "el orden de los acontecimientos: la preparación de Luis, el viaje al Casino, el descubrimiento de que los juguetes se agotaron y el arreglo del caballito", strategy: "organiza los acontecimientos principales en una línea de tiempo" },
    { id: "contexto-familiar", competency: LITERAL, label: "Situación de la familia", strength: "reconocer la situación familiar que enmarca la historia", gap: "relacionar la tristeza de la Navidad con la situación económica de la familia", study: "la situación económica de la familia y su efecto en la Navidad", strategy: "subraya las causas que el texto da para cada emoción de los personajes" },
    { id: "causa-situacion", competency: INFERENCIAL, label: "Causa de una reacción", strength: "identificar qué situación provoca la reacción de un personaje", gap: "identificar qué situación provoca la reacción de un personaje", study: "la relación causa-efecto entre los hechos y las exclamaciones de Zezé", strategy: "antes de interpretar una frase, pregúntate qué acaba de pasar en la escena" },
    { id: "emociones-personajes", competency: INFERENCIAL, label: "Emociones de los personajes", strength: "interpretar emociones a partir de las miradas, gestos y acciones de los personajes", gap: "interpretar emociones a partir de las miradas, gestos y acciones de los personajes", study: "cómo las acciones y las miradas revelan sentimientos que el texto no nombra", strategy: "relee el fragmento sobre la reacción del padre de Zezé y explica qué emociones transmite sin limitarte al significado literal de las palabras" },
    { id: "lenguaje-figurado", competency: INFERENCIAL, label: "Lenguaje figurado", strength: "reconocer el efecto de las imágenes y del lenguaje figurado", gap: "comprender el significado de metáforas, hipérboles y otras formas de lenguaje figurado", study: "la hipérbole, la metáfora y la comparación como recursos literarios", strategy: "marca las imágenes que no pueden entenderse de forma literal y explica qué efecto buscan" },
    { id: "tipologia-textual", competency: INFERENCIAL, label: "Tipo de texto", strength: "reconocer el tipo de texto y sus rasgos", gap: "reconocer el tipo de texto a partir de sus rasgos", study: "los tipos de texto (narrativo, argumentativo, informativo e instructivo) y sus rasgos", strategy: "identifica la intención del texto y su estructura antes de elegir su tipología" },
    { id: "funcion-narrativa", competency: INFERENCIAL, label: "Función de un episodio", strength: "comprender la función de un episodio dentro de la historia", gap: "comprender la función de un episodio dentro del desarrollo de la historia", study: "los puntos de giro y el desarrollo de la trama", strategy: "para cada episodio importante, pregúntate qué cambia en los personajes después de él" },
    { id: "critica-social", competency: CRITICA, label: "Crítica social", strength: "reconocer conflictos y críticas sociales presentes en la historia", gap: "reconocer la crítica social que surge al contrastar situaciones de desigualdad", study: "la desigualdad social y la forma en que la historia la representa", strategy: "contrasta dos escenas y formula qué problema social ponen en evidencia" },
    { id: "interpretacion-simbolica", competency: CRITICA, label: "Interpretación simbólica", strength: "interpretar el sentido simbólico de un título o una imagen", gap: "interpretar el sentido simbólico de los títulos y las imágenes", study: "la interpretación simbólica de títulos y metáforas", strategy: "explica con tus palabras qué sentido figurado aporta el título al conjunto de la historia" },
    { id: "motivaciones", competency: CRITICA, label: "Motivaciones de los personajes", strength: "comprender las motivaciones y decisiones de los personajes", gap: "comprender las motivaciones y las actitudes de los personajes", study: "la relación entre las circunstancias económicas, los afectos y las decisiones personales", strategy: "justifica cada decisión de un personaje con una evidencia concreta de la lectura" },
    { id: "conclusiones-evidencias", competency: CRITICA, label: "Conclusiones con evidencias", strength: "sustentar una conclusión con evidencias de la lectura", gap: "elegir la conclusión mejor sustentada en la lectura", study: "cómo formular y justificar conclusiones con evidencias textuales", strategy: "practica preguntas que exijan justificar una conclusión mediante evidencias concretas de la lectura" },
  ],
  sections: [
    {
      title: "Sesión 1 — Personajes y acontecimientos",
      description: "Comprensión literal. Dificultad: fácil a media. Cinco preguntas; máximo 30 minutos y 2 minutos por pregunta.",
      questions: [
        q(LITERAL, "Narrador y perspectiva", "narrador-perspectiva", "EASY", "¿Quién narra los acontecimientos del capítulo y desde qué perspectiva?",
          ["Un narrador externo que conoce los pensamientos de toda la familia.", "Zezé, quien cuenta sus propias experiencias en primera persona.", "Totoca, quien relata los problemas de su hermano menor.", "Gloria, quien recuerda los acontecimientos en tercera persona."], "B",
          "El capítulo está contado por Zezé en primera persona: él cuenta lo que vive, piensa y siente. Por eso solo conocemos los pensamientos de los demás a través de lo que él ve o interpreta."),
        q(LITERAL, "Personajes y relaciones", "personajes-relaciones", "MEDIUM", "¿Cuál de las siguientes relaciones entre personajes y elementos de la historia es correcta?",
          ["Luciano es el hermano menor; Minguito es un juguete; Luis es un vecino.", "Minguito es el murciélago; Luciano es el padre; Luis es el cartero.", "Luis es el hermano mayor; Luciano es el caballo; Minguito es el cartero.", "Luciano es un murciélago; Minguito es la planta de naranja-lima; Luis es el hermano menor de Zezé."], "D",
          "Luciano es un murciélago, Minguito es la planta de naranja-lima y Luis es el hermano menor de Zezé. Las demás opciones mezclan los papeles de personajes y elementos de la historia."),
        q(LITERAL, "Acontecimientos del capítulo", "acontecimientos-clave", "EASY", "¿Qué hace Gloria finalmente para permitir que Zezé y Luis vayan a recibir juguetes?",
          ["Busca a una persona conocida que pueda acompañarlos.", "Decide acompañarlos personalmente hasta el Casino Bangú.", "Pide al padre que suspenda su trabajo y los lleve.", "Encarga a Totoca que los lleve en bicicleta."], "A",
          "Gloria no puede ir con ellos: busca a una persona conocida que los acompañe, y así los niños pueden ir al Casino Bangú."),
        q(LITERAL, "Orden de los sucesos", "secuencia-cronologica", "MEDIUM", "¿Cuál secuencia respeta el orden de los acontecimientos?",
          ["Totoca repara el caballito, Zezé va al Casino y después viste a Luis.", "Zezé recibe regalos, visita a su tío y lleva a Luis al Casino.", "Zezé prepara a Luis, ambos caminan hasta el Casino, descubren que los juguetes se agotaron y posteriormente Totoca arregla el caballito.", "Zezé compra un regalo para su padre, después visita el Casino y finalmente conoce a Minguito."], "C",
          "Primero Zezé prepara a Luis; luego caminan hasta el Casino, donde descubren que los juguetes se agotaron; solo después Totoca arregla el caballito. Las otras opciones alteran ese orden."),
        q(LITERAL, "Situación de la familia", "contexto-familiar", "EASY", "¿Qué circunstancia explica principalmente la tristeza de la familia durante la Navidad?",
          ["La familia se encuentra separada por una discusión entre los hermanos.", "El padre está desempleado y la familia atraviesa dificultades económicas.", "La familia está obligada a abandonar definitivamente su ciudad.", "Los niños se niegan a participar en las celebraciones navideñas."], "B",
          "La tristeza nace de la falta de trabajo del padre y de las dificultades económicas, que impiden a la familia celebrar la Navidad como otras familias."),
      ],
    },
    {
      title: "Sesión 2 — Análisis de un fragmento",
      description: "Comprensión inferencial. Dificultad: media. Cinco preguntas sobre un mismo fragmento, que permanece visible; máximo 30 minutos y 2 minutos por pregunta.",
      passage: {
        title: "Fragmento del capítulo «Los flacos dedos de la pobreza»",
        body: [
          p("—¡Qué desgracia es tener un padre pobre!..."),
          p("Desvié mis ojos de las zapatillas hacia otras que estaban detenidas frente a mí. Papá se hallaba de pie, mirándonos. La tristeza había hecho enormes sus ojos. Parecía que habían crecido tanto, pero tanto, que cubrirían toda la pantalla del cine Bangú."),
        ],
      },
      questions: [
        q(INFERENCIAL, "Causa de la exclamación", "causa-situacion", "MEDIUM", "¿Qué situación provoca la exclamación inicial de Zezé?",
          ["La noticia de que la familia debe mudarse nuevamente.", "Una discusión con su hermano Totoca por el caballito.", "La prohibición de ir al Casino Bangú.", "La decepción de encontrar sus zapatillas vacías después de esperar un regalo de Navidad."], "D",
          "La exclamación nace de la decepción: Zezé esperaba un regalo de Navidad y sus zapatillas siguen vacías. Nada en el fragmento habla de una mudanza, una pelea o una prohibición."),
        q(INFERENCIAL, "Emociones del padre", "emociones-personajes", "MEDIUM", "¿Qué comprende el lector cuando Zezé descubre a su padre frente a él?",
          ["Que el padre ha presenciado el momento y sufre por las palabras de su hijo.", "Que su padre está enojado porque Zezé no ha realizado las tareas domésticas.", "Que el padre desconoce las dificultades que enfrenta la familia.", "Que su padre había escondido los regalos para sorprenderlo después."], "A",
          "El padre está de pie, mirándolos, y su tristeza se vuelve visible: el lector infiere que escuchó la frase de Zezé y que le dolió. El texto no sugiere enojo, desconocimiento ni regalos escondidos."),
        q(INFERENCIAL, "Hipérbole", "lenguaje-figurado", "MEDIUM", "¿Qué efecto produce la imagen de los ojos del padre tan grandes que podrían cubrir la pantalla del cine?",
          ["Permite conocer el tamaño real de los ojos del personaje.", "Anuncia una enfermedad física que afectará al padre.", "Intensifica la tristeza del padre tal como Zezé la percibe.", "Demuestra que Zezé confunde la realidad con una película que está viendo."], "C",
          "Es una hipérbole: la exageración no describe un tamaño real, sino la inmensidad de la tristeza del padre tal como la percibe Zezé."),
        q(INFERENCIAL, "Tipo de texto", "tipologia-textual", "MEDIUM", "¿Qué tipo de texto predomina en este fragmento?",
          ["Un texto argumentativo que defiende una tesis económica.", "Un texto narrativo literario que integra diálogo y descripción.", "Un texto instructivo que explica cómo actuar ante un conflicto.", "Un texto informativo que presenta datos estadísticos sobre la pobreza."], "B",
          "El fragmento cuenta una escena con un personaje que habla (diálogo) y con descripciones, como la de los ojos del padre: es un texto narrativo literario."),
        q(INFERENCIAL, "Función en la trama", "funcion-narrativa", "MEDIUM", "¿Qué función cumple este momento dentro del desarrollo de la historia?",
          ["Resuelve definitivamente los problemas económicos de la familia.", "Introduce un nuevo personaje que cambiará la situación familiar.", "Explica por qué la familia debe abandonar la casa.", "Marca un punto de cambio que conduce a Zezé al arrepentimiento y al deseo de reparar el daño causado."], "D",
          "Al ver el dolor de su padre, Zezé se arrepiente y quiere reparar el daño: este momento es un punto de giro de la historia. No resuelve los problemas económicos ni introduce personajes nuevos."),
      ],
    },
    {
      title: "Sesión 3 — Interpretación crítica",
      description: "Lectura crítica. Dificultad: media a alta. Cinco preguntas; máximo 30 minutos y 2 minutos por pregunta.",
      questions: [
        q(CRITICA, "Desigualdad social", "critica-social", "MEDIUM", "¿Qué crítica social se evidencia al contrastar los regalos de las familias adineradas con la Navidad de Zezé?",
          ["Que todas las familias deberían celebrar la Navidad de la misma manera.", "Que los niños pobres son menos responsables que los niños ricos.", "Que las desigualdades económicas afectan las oportunidades y experiencias de los niños.", "Que los regalos materiales son la única forma válida de demostrar afecto."], "C",
          "El contraste muestra que la situación económica de la familia condiciona lo que los niños pueden vivir y recibir. Ninguna de las otras opciones se sostiene en la historia."),
        q(CRITICA, "Interpretación del título", "interpretacion-simbolica", "MEDIUM", "¿Qué interpretación representa mejor el título «Los flacos dedos de la pobreza»?",
          ["La pobreza condiciona la vida material y también afecta las emociones y relaciones familiares.", "Los personajes padecen una enfermedad que provoca debilidad en sus manos.", "La historia trata principalmente sobre el trabajo manual de los adultos.", "La pobreza es una situación pasajera que no influye en la convivencia familiar."], "A",
          "El título personifica la pobreza como una mano que alcanza a la familia: afecta lo material, pero también las emociones y las relaciones. Leerlo de forma literal (enfermedad, trabajo manual) pierde ese sentido simbólico."),
        q(CRITICA, "Motivación de Zezé", "motivaciones", "MEDIUM", "¿Cuál es la principal motivación de Zezé para trabajar lustrando zapatos el día de Navidad?",
          ["Reunir dinero para comprar la bicicleta que tiene Sergito.", "Comprar un regalo para su padre como una forma de expresar afecto y arrepentimiento.", "Demostrar a Totoca que puede ganar más dinero que él.", "Conseguir suficiente dinero para mudarse sin la ayuda de su familia."], "B",
          "Zezé trabaja para comprarle un regalo a su padre: es su manera de expresar afecto y de reparar el daño que le causó con sus palabras."),
        q(CRITICA, "Actitud de Sergito", "motivaciones", "HARD", "¿Qué revela la actitud de Sergito cuando ofrece prestarle dinero a Zezé?",
          ["Que considera a Zezé incapaz de conseguir dinero por sí mismo.", "Que desea recibir a cambio el caballito Rayo de Luna.", "Que busca aprovecharse del trabajo de Zezé para pagar menos.", "Que muestra solidaridad y acepta ayudarlo mediante un préstamo, respetando que Zezé no quiera cobrar a sus amigos."], "D",
          "Sergito ofrece un préstamo como gesto de solidaridad y respeta que Zezé no quiera cobrar a sus amigos. No hay en la escena desconfianza, interés por el caballito ni deseo de aprovecharse."),
        q(CRITICA, "Reconciliación", "conclusiones-evidencias", "HARD", "¿Cuál de las siguientes conclusiones interpreta mejor la reconciliación final entre Zezé y su padre?",
          ["Los problemas familiares desaparecen cuando alguien recibe un regalo.", "El padre perdona a Zezé únicamente porque recibió un objeto costoso.", "El afecto y el perdón permiten reparar su relación, aunque la situación económica continúe siendo difícil.", "Zezé comprende que debe ocultar sus sentimientos para evitar conflictos."], "C",
          "La reconciliación no cambia la situación económica: lo que repara la relación es el afecto y el perdón. Un regalo no hace desaparecer los problemas ni explica por sí solo el perdón del padre."),
      ],
    },
  ],
};

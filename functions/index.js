const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();

const db = admin.firestore();

// Función principal del juego - SEGURA, ejecutada en servidor
exports.spinSlot = functions.https.onCall(async (data, context) => {
  const { codigo } = data;
  
  // 1. Validación básica
  if (!codigo || typeof codigo !== 'string') {
    throw new functions.https.HttpsError('invalid-argument', 'Código inválido');
  }

  const codigoRef = db.collection('codigos').doc(codigo);
  const configRef = db.collection('config').doc('actual');

  try {
    // 2. Transacción atómica para evitar race conditions
    const resultado = await db.runTransaction(async (transaction) => {
      const codigoDoc = await transaction.get(codigoRef);
      const configDoc = await transaction.get(configRef);

      // Verificar código existe
      if (!codigoDoc.exists) {
        throw new functions.https.HttpsError('not-found', 'Código inválido');
      }

      const codigoData = codigoDoc.data();

      // Verificar código no usado
      if (codigoData.usado) {
        throw new functions.https.HttpsError('already-exists', 'Código ya usado');
      }

      // Verificar config existe
      if (!configDoc.exists) {
        throw new functions.https.HttpsError('internal', 'Configuración no disponible');
      }

      const config = configDoc.data();

      // 3. LÓGICA DEL JUEGO - DETERMINAR GANADOR (Server-side, seguro)
      const premiosRestantes = config.premios_restantes || 0;
      const probabilidad = config.probabilidad || 0.1; // 10% por defecto
      
      let gana = false;
      let simboloGanador = null;
      const simbolos = ["💎", "💰", "👑", "🍀", "⭐"];
      
      // Si hay premios disponibles y pasa la probabilidad
      if (premiosRestantes > 0 && Math.random() < probabilidad) {
        gana = true;
        simboloGanador = simbolos[Math.floor(Math.random() * simbolos.length)];
      } else {
        // Perdedor: 3 símbolos aleatorios diferentes (o 2 iguales, 1 diferente)
        gana = false;
      }

      // 4. Actualizar código como usado
      transaction.update(codigoRef, {
        usado: true,
        ganador: gana,
        fecha_uso: admin.firestore.FieldValue.serverTimestamp(),
        userId: context.auth?.uid || null
      });

      // 5. Si ganó, decrementar premios restantes
      if (gana) {
        transaction.update(configRef, {
          premios_restantes: premiosRestantes - 1,
          ultimo_ganador: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      // 6. Guardar resultado del spin
      const resultadoRef = db.collection('resultados').doc();
      transaction.set(resultadoRef, {
        codigo: codigo,
        gano: gana,
        simbolo: simboloGanador,
        premio_nombre: gana ? config.premio_nombre : null,
        fecha: admin.firestore.FieldValue.serverTimestamp(),
        userId: context.auth?.uid || null
      });

      return {
        gana: gana,
        simbolo: simboloGanador,
        simbolosMostrados: gana ? [simboloGanador, simboloGanador, simboloGanador] : generarSimbolosPerdedor(simbolos),
        premio_nombre: gana ? config.premio_nombre : null,
        premios_restantes: gana ? premiosRestantes - 1 : premiosRestantes
      };
    });

    return resultado;

  } catch (error) {
    console.error('Error en spinSlot:', error);
    throw new functions.https.HttpsError('internal', error.message || 'Error del servidor');
  }
});

// Helper para generar símbolos de perdedor (no 3 iguales)
function generarSimbolosPerdedor(simbolos) {
  let s1, s2, s3;
  do {
    s1 = simbolos[Math.floor(Math.random() * simbolos.length)];
    s2 = simbolos[Math.floor(Math.random() * simbolos.length)];
    s3 = simbolos[Math.floor(Math.random() * simbolos.length)];
  } while (s1 === s2 && s2 === s3); // Evitar que sean los 3 iguales
  
  return [s1, s2, s3];
}

// Función para obtener config pública (premio actual)
exports.getConfig = functions.https.onCall(async (data, context) => {
  const configDoc = await db.collection('config').doc('actual').get();
  if (!configDoc.exists) return {};
  
  const data = configDoc.data();
  // Solo devolver info pública, no probabilidad interna
  return {
    premio_nombre: data.premio_nombre,
    premios_restantes: data.premios_restantes
  };
});

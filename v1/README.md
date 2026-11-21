# Random Cutthroat 1.0 – Praxistest

Eigenständiges Tampermonkey-Userscript, Version 1.0.0-beta.1. Es hat einen eigenen Eintrag und speichert seine Partien getrennt von 0.4.4. Vorhandene Spielernamen, Board-Adresse und Grundeinstellungen werden beim ersten Start aus 0.4.4 übernommen. Die erste Partie der neuen Version beginnt mit null Punkten.

## Am Darts-PC installieren

1. Die ZIP entpacken und die Datei `random-cutthroat.user.js` im Texteditor öffnen.
2. In Tampermonkey **Neues Benutzerskript erstellen** wählen. Den Vorgabetext vollständig durch den Dateiinhalt ersetzen und mit **Strg+S** speichern.
3. In der Tampermonkey-Übersicht für diesen Test den bisherigen Eintrag **Autodarts – Cricket Random Cutthroat** deaktivieren und den Eintrag **Autodarts – Random Cutthroat 1.0 (Praxistest)** aktivieren.
4. Den geöffneten Autodarts-Tab mit **F5** neu laden. Im Overlay steht **1.0.0-beta.1**. Für eine Rückkehr die beiden Schalter wieder umstellen und den Tab neu laden.

## Erste Aufnahme

**Mit Kameras** wählen und das Board leeren. Läuft Autodarts Desktop am selben PC, ist die Adresse `http://localhost:3180`. Bei einem separaten Kamera-PC seine Netzwerkadresse eintragen und **Verbinden** drücken. Neben dem Verbindungsstatus stehen das letzte Board-Ereignis und die vom Board gemeldeten Treffer. **Ziele auslosen & starten** drücken. Nach dem ersten erkannten Dart sollte die aktuelle Aufnahme **1/3 Darts** und dessen Segment anzeigen. Auch Treffer außerhalb der sieben Ziele belegen einen Wurfplatz. Nach dem Herausziehen sollte der nächste Spieler erscheinen.

Jeder der drei Wurfplätze ist korrigierbar. **Vorheriger Spieler** öffnet die letzte Aufnahme erneut, solange die neue Aufnahme leer ist. Bei einer Verbindungsunterbrechung die tatsächlich steckenden Darts mit der Diagnose vergleichen und **Board-Aufnahme übernehmen** oder **Nächster Spieler** wählen.

## Lokal und online spielen

Zwei bis acht Namen eingeben und vor dem Start am Drei-Pfeil-Griff verschieben. Per Tastatur den Griff mit Tab auswählen und mit ↑ oder ↓ bewegen. Drei Marks schließen ein Ziel. Überzählige Marks bringen Strafpunkte für Gegner mit offenem Ziel. Alle sieben Ziele und der niedrigste oder geteilte niedrigste Punktestand entscheiden das Spiel.

Für zwei getrennte Boards öffnet der Host **Raum erstellen** und gibt den Code an den Gast. Beide verwenden diese neue Version. Jeder stellt seinen eigenen Eingabemodus ein. Der Host startet und speichert die Partie. Für die Vermittlung braucht PeerJS Internetzugang. Nach einer Unterbrechung kann der Gast dem Raum erneut beitreten. Nach einem Neuladen beim Host **Raum erneut öffnen** und den neuen Code teilen. **Online verlassen** erlaubt dem Host, die Partie am gemeinsamen Board fortzusetzen.

## Bisher geprüft

`npm run check` und `npm test` aus dem Repository-Stamm. Die neuen Tests liegen in `tests/v1*.test.cjs`. Sie prüfen unter anderem komplette Partien mit zwei, drei und acht Spielern und den Datenaustausch zweier isolierter Script-Instanzen. Beim Nachspielen von Board-Aufzeichnungen wurden acht vollständige Aufnahmen einschließlich Spielerwechsel mit den erwarteten Treffern verglichen. Der praktische Test mit dem eigenen Kamera-Board und der Online-Test über zwei Internetanschlüsse stehen aus.

# Autodarts Random Cutthroat Cricket

Ein Tampermonkey-Userscript für **play.autodarts.com**, das Random Cutthroat Cricket direkt als Overlay in der Autodarts-Weboberfläche anzeigt und Treffer vom lokalen Autodarts Board Manager verarbeitet.

## Regeln

- 7 verschiedene Ziele pro Spiel.
- Ziele werden aus **1–20** gezogen.
- Bull-Modus: **Immer / Nie / Zufällig**.
  - **Immer:** Bull + 6 zufällige Zahlen.
  - **Nie:** 7 zufällige Zahlen aus 1–20.
  - **Zufällig:** 7 Ziele aus 1–20 + Bull; Bull hat dieselbe Chance wie jede Zahl.
- 3 Marks schließen ein Ziel.
- Single = 1 Mark, Double = 2 Marks, Triple = 3 Marks.
- Outer Bull = 1 Mark, Bullseye = 2 Marks.
- Cutthroat: Überzählige Marks nach dem Schließen geben Strafpunkte an **jeden Gegner**, der dieses Ziel noch offen hat.
- Gewinner: alle 7 Ziele geschlossen und niedrigster bzw. geteilter niedrigster Punktestand.

## Beispiel

Du hast die 18 bereits mit 3 Marks geschlossen, dein Gegner noch nicht. Du triffst T18. Dein Gegner bekommt 54 Strafpunkte. Bei drei Spielern erhalten alle Gegner mit offener 18 jeweils 54 Punkte.

## Installation

1. Tampermonkey in dem Browser installieren, in dem `https://play.autodarts.com` läuft.
2. Dieses Repository öffnen und `autodarts-random-cutthroat.user.js` als Raw-Datei aufrufen.
3. Tampermonkey bietet die Installation des Scripts an.
4. Autodarts neu laden.
5. Unten rechts erscheint **🎯 Random Cutthroat**.

## Board Manager verbinden

Das Script liest die Treffer über die lokale Autodarts Board Manager WebSocket-API.

Standard:

- Board Manager HTTP: `http://autodarts.local:3180`
- Board Manager HTTPS/WSS: `https://autodarts.local:3181`

Da `play.autodarts.com` über HTTPS läuft, sollte die Verbindung über **WSS/Port 3181** erfolgen.

Falls der Board Manager ein selbstsigniertes Zertifikat verwendet:

1. Im selben Browser `https://autodarts.local:3181` öffnen (oder Host/IP deines Raspberry Pi).
2. Zertifikatswarnung einmal akzeptieren.
3. Danach `play.autodarts.com` öffnen und im Random-Cutthroat-Fenster auf **Verbinden** drücken.

Wenn dein Raspberry anders heißt, im Setup z. B. `192.168.1.50` oder `dartboard.local` eintragen.

## Wichtiger technischer Hinweis

Random Cutthroat ist **kein offizieller Autodarts-Server-Spielmodus**. Das Userscript legt die Anzeige direkt über die Autodarts-Webseite und führt die Random-Cutthroat-Spielregeln lokal im Browser aus. Die Darterkennung kommt weiterhin vom normalen Autodarts Board Manager.

Dadurch müssen wir die Autodarts-Cloud oder deren Spielengine nicht verändern.

## Bedienung

- **Ziele auslosen & starten**: neues Spiel mit 7 Random-Zielen.
- **Undo**: letzten vom Overlay verarbeiteten Dart zurücknehmen.
- **Nächster Spieler**: manueller Spielerwechsel, falls nötig.
- Bei `Takeout finished` vom Board Manager wechselt der Spieler automatisch.
- Unter **Testwürfe** kann das Spiel auch ohne angeschlossenes Board getestet werden.

## Update

Tampermonkey nutzt die `@updateURL`/`@downloadURL` im Script und kann neue Versionen direkt aus diesem Repository installieren.

## Status

Version **0.1.0** ist die erste Testversion. Sie enthält die vollständige Grundlogik, muss aber an einem echten Autodarts-Board auf das konkrete Board-Event-Verhalten getestet werden.

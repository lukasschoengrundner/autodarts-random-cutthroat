# Autodarts Random Cutthroat Cricket

Ein Tampermonkey-Userscript für **play.autodarts.com** und **play.autodarts.io**. Es zeigt Random Cutthroat Cricket als Overlay an und verarbeitet Treffer vom lokalen Autodarts Board Manager.

**Version 0.2.0:** Windows-Voreinstellung, vollständige Aufnahmen, Wurfkorrekturen und ein eigener Testmodus ohne Kameras. Die automatisierten Tests und der lokale Browsertest verwenden simulierte Board-Meldungen. Ein Praxistest mit echten Kameras steht noch aus.

## Aufbau unter Windows

```text
Kameras → Autodarts Desktop / Board Manager → Userscript im Browser → Spielstand
```

Autodarts Desktop übernimmt die Kameraerkennung. Dieses Script übernimmt nur die Spielregeln und die Anzeige. Es benötigt keinen Raspberry Pi und keinen zusätzlichen Python-, Docker- oder Node-Dienst. Node.js ist nur für die Entwicklungstests erforderlich.

Das Script ist ein **lokales Spieloverlay**, kein offizieller Spielmodus des Autodarts-Servers. Es synchronisiert seine Punkte und Spieler nicht mit einem parallel laufenden offiziellen Match. Während einer Partie nur einen Browser-Tab mit diesem Overlay verwenden.

## Installation oder Update

1. [Tampermonkey](https://www.tampermonkey.net/) im Browser installieren, in dem du Autodarts öffnest.
2. [Userscript installieren oder aktualisieren](https://raw.githubusercontent.com/lukasschoengrundner/autodarts-random-cutthroat/main/autodarts-random-cutthroat.user.js).
3. Die Installation beziehungsweise Aktualisierung in Tampermonkey bestätigen.
4. [Autodarts](https://play.autodarts.com/) neu laden. Das Fenster **Random Cutthroat** erscheint; nach dem Minimieren lässt es sich unten rechts wieder öffnen.

Wenn kein Overlay erscheint, prüfen, ob das Script in diesem Browserprofil aktiviert ist und Tampermonkey Userscripts ausführen darf. Dazu gibt es die [Tampermonkey-Hilfe](https://www.tampermonkey.net/faq.php#Q209).

Tampermonkey kann Updates über die im Script eingetragenen `@updateURL` und `@downloadURL` von diesem Repository beziehen. Keine zweite Kopie parallel aktivieren.

### Übernahme von Version 0.1.0

- Die alte Standardadresse `autodarts.local` wird einmalig auf `http://localhost:3180` umgestellt. Individuell eingetragene Adressen bleiben erhalten.
- Spielernamen und gültige Spielstände bleiben erhalten. Eine laufende alte Aufnahme hat noch keine vollständige Wurfliste: Sie muss abgeschlossen oder durch ein neues Spiel ersetzt werden. Ihr bereits gespeicherter Punktestand bleibt erhalten.
- Einstellungen und Spielstand liegen im lokalen Browserspeicher. Andere Browserprofile sowie die Domains `.com` und `.io` verwenden getrennte Speicher.

## Sofort ohne Kameras testen

1. Im Setup **Ohne Kameras testen** auswählen.
2. Spielernamen und Bull-Modus einstellen.
3. **Ziele auslosen & starten** drücken.
4. Unter **Testwürfe** Single, Double, Triple oder MISS anklicken.
5. Nach drei Darts sind weitere Testwürfe gesperrt. Mit **Nächster Spieler** wechseln oder mit **Undo** den letzten Testwurf zurücknehmen.

In diesem Modus werden keine Board-Verbindungen aufgebaut und keine Kameraereignisse verarbeitet. Bei Bull gibt es ausschließlich Single und Double.

## Später die Kameras verbinden

### Browser und Kameras auf demselben Windows-PC

1. Autodarts Desktop starten und die Erkennung dort prüfen.
2. Den [Board Manager](http://localhost:3180) öffnen. Der Hersteller dokumentiert diese lokale Adresse in der [Autodarts-Desktop-Anleitung](https://docs.autodarts.com/getting-started/detection/autodarts-desktop/#board-manager).
3. Im Script **Mit Kameras** wählen und `http://localhost:3180` eintragen.
4. **Verbinden** drücken und anschließend ein Spiel starten.
5. Das Board zu Beginn leeren. Erst nach einer leeren Board-Meldung werden neue Würfe gewertet.

### Browser auf einem anderen Gerät

Die Netzwerkadresse des **Kamera-PCs** eintragen, zum Beispiel `http://192.168.1.50:3180`. `localhost` bezeichnet immer das Gerät, auf dem der Browser läuft. Der Board Manager muss vom anderen Gerät im lokalen Netzwerk erreichbar sein.

### Protokoll und Browserfreigaben

| Eingabe | Verbindung |
|---|---|
| `localhost` oder `localhost:3180` | `ws://localhost:3180/api/events?type=state` |
| `http://192.168.1.50:3180` | `ws://192.168.1.50:3180/api/events?type=state` |
| `https://board.local:3181` | `wss://board.local:3181/api/events?type=state` |

Ein HTTPS-Spieltab darf nicht in jeder Browserkonfiguration auf einen unverschlüsselten lokalen WebSocket zugreifen. Aktuelle Chrome-Versionen verlangen dafür eine Freigabe für **lokalen Netzwerkzugriff**; seit Chrome 147 betrifft diese auch WebSockets. Bei einer entsprechenden Abfrage die Freigabe für die Autodarts-Seite prüfen. [Chrome-Dokumentation](https://developer.chrome.com/release-notes/147?hl=en)

Falls der Browser die WS-Verbindung blockiert, kann ein vom Board Manager angebotener HTTPS/WSS-Endpunkt verwendet werden. Port 3181 funktioniert nur, wenn er auf dieser Installation tatsächlich angeboten wird und sein Zertifikat für den verwendeten Namen im Browser akzeptiert wird. Das Script installiert keine Zertifikate und ändert keine Browser- oder Firewall-Einstellungen. Die Erreichbarkeit von HTTP-Port 3180 beweist nicht die Verfügbarkeit von HTTPS-Port 3181.

Unter **Verbindungsdiagnose** stehen Adresse, Verbindungsstatus, letztes Board-Ereignis und Wurfanzahl. Bei allgemeinen WebSocket-Fehlern kann der Browser dem Script keine genaue Ursache nennen; Browser-Konsole, Netzwerkfreigabe und gegebenenfalls Zertifikat helfen dann bei der Diagnose.

## Wertung, Korrekturen und Spielerwechsel

- Das Script gleicht die **gesamte aktuelle Aufnahme** ab. Fehlt eine Zwischenmeldung, können die später darin enthaltenen Würfe nachgetragen werden. Identische Meldungen zählen nicht erneut.
- Ändert das Board ein Segment, wird die Aufnahme einschließlich Strafpunkten neu berechnet. Änderungen werden aus konsistenten `state`-Meldungen übernommen, statt nur den letzten Dart einer Liste hinzuzuzählen.
- Über die Auswahl **Dart 1/2/3 korrigieren** kann ein Dart lokal ersetzt, gestrichen oder auf seinen Originalwert zurückgestellt werden. Diese Korrektur verändert nicht den Board Manager oder ein offizielles Match.
- **Letzten Dart streichen** nimmt im Kameramodus dessen Wertung zurück, lässt den physischen Wurfplatz aber belegt. Wiederholte Board-Meldungen fügen ihn dadurch nicht erneut hinzu. Eine spätere echte Änderung dieses Board-Segments ersetzt die lokale Korrektur.
- Im Testmodus entfernt **Undo** den letzten Testwurf und gibt den Wurfplatz wieder frei. Undo und Korrekturen gelten nur für die aktuelle Aufnahme.
- **Takeout finished** mit leerem Board schließt die Aufnahme ab und wechselt automatisch den Spieler. Beim Herausziehen werden vorübergehend schrumpfende Listen nicht neu gewertet.
- **Nächster Spieler** wechselt manuell genau einmal und wartet anschließend auf das leere Board. Meldungen der noch steckenden Darts werden nicht dem nächsten Spieler zugeordnet.
- Fehlwürfe außerhalb des Boards bei Bedarf im Board Manager als MISS ergänzen. Eine Aufnahme kann auch vor dem dritten Dart manuell abgeschlossen werden.
- Ein Sieger kann vor dem Herausziehen noch durch eine Wurfkorrektur geändert werden. Nach dem abschließenden Herausziehen bleibt das Spiel beendet.

### Verbindung unterbrochen, Seite neu geladen oder Board zurückgesetzt

Nach einer Unterbrechung kann das Script ohne eindeutige Aufnahme-ID nicht wissen, ob inzwischen ein Spielerwechsel stattgefunden hat. Deshalb hält es die Wertung an:

- Gehören die angezeigten Board-Darts zur aktuellen Aufnahme, **Aufnahme für aktuellen Spieler übernehmen** wählen.
- Wurden die Darts bereits entfernt, **Aufnahme abschließen** wählen. Die bisherige Wertung bleibt erhalten und der Spieler wechselt einmal. Anschließend wartet das Script auf eine leere Board-Meldung.
- Ist die aktuelle Aufnahme ungewertet und das Board leer, **Mit leerem Board fortsetzen** wählen.

Ein während der laufenden Erkennung empfangener **Manual reset** nimmt die Wertung der aktuellen Aufnahme zurück, einschließlich ihrer Strafpunkte. Frühere Aufnahmen bleiben erhalten. Danach die Darts herausziehen und das leere Board bestätigen. Ein erst nach einer Wiederverbindung empfangener Reset-Zustand wird nicht ungefragt auf einen alten Spielstand angewendet.

## Regeln

- Sieben verschiedene Ziele pro Spiel aus 1–20, optional Bull.
- **Bull immer:** Bull plus sechs zufällige Zahlen. **Bull nie:** sieben Zahlen. **Bull zufällig:** sieben Ziele aus 1–20 plus Bull, mit gleicher Auswahlchance pro Ziel.
- Drei Marks schließen ein Ziel. Single zählt einen, Double zwei und Triple drei Marks. Outer Bull zählt einen, Bullseye zwei Marks.
- Überzählige Marks geben Strafpunkte an jeden Gegner, der das Ziel noch offen hat: Zielwert mal überzählige Marks; bei Bull ist der Zielwert 25.
- Gewonnen hat, wer alle sieben Ziele geschlossen und den niedrigsten oder geteilten niedrigsten Punktestand hat.
- Zwei bis acht lokale Spieler.

Beispiel: Deine 18 ist geschlossen. T18 gibt jedem Gegner mit offener 18 jeweils 54 Strafpunkte.

## Entwicklung und Teststatus

Node.js 20 oder neuer, keine zusätzlichen Pakete:

```sh
npm run check
npm test
```

Die Tests führen die tatsächlichen Funktionen des Userscripts mit isoliertem Speicher und simulierten WebSockets aus. Sie prüfen unter anderem fehlende/duplizierte Meldungen, Korrekturen, Reset, Spielerwechsel, Wiederverbindung, Migration, Regeln und die Drei-Dart-Grenze. Ein lokaler Browsertest prüfte zusätzlich Testmodus, Korrekturauswahl, Undo, Spielerwechsel und simulierten Verbindungsabbruch.

**Noch nicht geprüft:** echte Kameras, die genaue Detection-Version des Boards, Tampermonkey auf der echten Autodarts-Seite und die tatsächlichen Browser-/Zertifikatsbedingungen am Kamera-PC. Die Version ist deshalb weiterhin eine Testversion.

Als Referenz für das lokale Ereignisformat dient das [Autodarts-Local-API-Beispiel](https://github.com/tnolle/autodarts-local-api/blob/main/example.jsonc). Unerwartete, unvollständige oder mehr als drei Würfe umfassende Zustände werden nicht blind gewertet.

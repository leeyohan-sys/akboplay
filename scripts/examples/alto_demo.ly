\version "2.24.0"

\header {
  title = "알토 2성부 예제"
  composer = "AkboPlay"
  tagline = ##f
}

melody = \relative c' {
  \key c \major
  \time 4/4
  c4 d e f | g2 e | f4 d c2 |
}

alto = \relative c' {
  \key c \major
  \time 4/4
  a4 b c d | e2 c | d4 b a2 |
}

\score {
  \new ChoirStaff <<
    \new Staff \with { instrumentName = "Mel" } {
      \clef treble \melody
    }
    \new Staff \with { instrumentName = "Alto" } {
      \clef treble \alto
    }
  >>
  \layout { }
  \midi { \tempo 4 = 96 }
}

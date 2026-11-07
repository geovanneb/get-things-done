/**
 * Common English words of four letters or more that turn up capitalised in business writing (headings, table headers,
 * product and team names). On its own, a capital is not enough to treat one of them as a misspelt name: only an
 * honorific or another part of the same person's name is. Lower case, one per word.
 */
export const COMMON_WORDS = new Set(`
able about above access account across action active actual added adding address admin advice advisory after again
against agenda agent agents agree agreed ahead alert align allow almost alone along already also always amount analysis
annual answer anyone apply approach approval approve april area areas around asked asset assets audit august author
average award away back backlog balance bank base based basic batch before begin being below benefit best better
between beyond bill blocked board body book both brand break brief bring budget build building built business call
calls card care case cases cash center central change changes chart check chief choice claim class clear client close
cloud code cold come comment common company complete content context control copy core cost costs count country course
cover create credit current customer daily dark data date dates days deal dealer dear decide decision deck default
delay deliver delivery demand demo design desk detail details develop device digital direct director done down draft
drive during early east easy edge edit effect effort else email emails end ends energy enough enter entry error even
event events every exact example expect expert extra face fact factor fail fair fall false fast feature february fee
feed field figure file files fill final finance find fine first fiscal five fix flag flat flow focus follow food form
format forum forward four frame free friday from front full fund funds future gain game gate general give global goal
goals going good grant graph great green grid gross ground group groups grow growth guide half hand handle hard have head
health hello help here high hold holding home hope hour hours house human idea ideas image impact income index info
input inside insight issue issues item items january join joint journal july june just keep key kind know label labor
land large last late launch layer lead leader leads lean learn least left legal less level light like limit line lines
link list live load loan local lock long look loop lost made main major make manager many march mark market master match
matter maybe means media meet meeting member memo menu message method middle might mind minor model models monday money
month monthly months more most move much must name names need needs network never news next nice night none north note
notes notice november number object october offer office often once only open option options order other outcome output
over owner pace pack page pages paid panel paper part parts party pass past path peak people period person phase phone
pick piece pilot place plan plans platform play plus point points policy pool portal post power press price prices
print priority private process product profile profit program project proof public pull push quality quarter query
question quick quote rate rates read ready real reason record region release report request result results return
review reviews right risk risks road role roles room root round rule rules runs safe sale sales same sample saturday
save scale scope score screen search season second section sector secure select self sell send senior sense series
serve server service set setup share shared sheet shift ship short show side sign signal simple single site size skill
slide slides small smart social soft sold solution some sort source space speed spend split staff stage stand standard
start state status step steps still stock stop store story strategy stream street strong study style sunday supply
support sure system table take talk target task tasks team teams term terms test text than thank that their them then
there these they thing think third this those three through thursday ticket time timeline times title today token
tool tools topic total touch tour track trade train trend trial true trust tuesday turn type under unit units until
update updates upon user users value values vendor version very view vision visit voice wait want watch water week
weekly weeks well were west what when where which while white whole wide will wind window wins with within without word
words work worker workflow world would write year yearly years yellow your zone
`.split(/\s+/).filter(Boolean));

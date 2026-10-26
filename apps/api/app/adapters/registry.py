from app.adapters.base import ArchiveAdapter
from app.adapters.digitalnz import DigitalNzAdapter
from app.adapters.internet_archive import InternetArchiveAdapter
from app.adapters.loc import LibraryOfCongressAdapter


ADAPTERS: dict[str, ArchiveAdapter] = {
    LibraryOfCongressAdapter.slug: LibraryOfCongressAdapter(),
    InternetArchiveAdapter.slug: InternetArchiveAdapter(),
    DigitalNzAdapter.slug: DigitalNzAdapter(),
}
